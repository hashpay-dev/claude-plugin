# Building the webhook handler

The webhook is how the seller's backend learns that money actually arrived. Nothing else is
authoritative: the browser widget can be closed mid-payment, and the buyer can pay after leaving the
page. **If the integration fulfils orders anywhere other than this handler, it is wrong.**

Working receivers to copy and adapt live next to this file:
`assets/handler-express.js` (Node) and `assets/handler-fastapi.py` (Python). Both are complete —
signature verification, replay window, idempotency, fast ack — and both have been verified against a
signature produced by HashPay's own signer.

## What HashPay sends

`POST` to the store's webhook URL, `content-type: application/json`.

| Header                | Value                                                                 |
|-----------------------|-----------------------------------------------------------------------|
| `X-HashPay-Event`     | the event type, e.g. `payment.confirmed`                              |
| `X-HashPay-Delivery`  | the event id — **the idempotency key**                                 |
| `X-HashPay-Signature` | `t=<unix-seconds>,v1=<hex>` — **one `v1` per active signing secret**   |

Body:

```json
{
  "id": "pay_9f3…:payment.confirmed",
  "type": "payment.confirmed",
  "createdAt": "2026-07-13T10:04:11Z",
  "apiVersion": "2026-07-02",
  "data": { "…": "see below" }
}
```

`id` is inside the signed body *and* mirrored in `X-HashPay-Delivery`, so it is authenticated — safe
to use as the dedupe key. It is derived deterministically from the state transition
(`<paymentId>:<type>`), never from the clock, so **a redelivery carries the same `id` as the
original**.

`apiVersion` is bumped only on a breaking payload change. Ignore it, or reject a shape you don't
know — but never fail closed on an *unknown event type* (see the rules).

## Event catalog

Payment events — the integration surface:

| Type                 | Meaning                                        | What the handler should do                       |
|----------------------|------------------------------------------------|--------------------------------------------------|
| `payment.detected`   | Seen on-chain, **not yet confirmed**           | Show "processing". **Do not fulfil.**            |
| `payment.confirmed`  | Confirmed at depth — **the money is final**    | **Fulfil here.** This is the only settlement event. |
| `payment.underpaid`  | Buyer sent less than the quoted amount         | Reconcile / partial-refund by hand               |
| `payment.overpaid`   | Buyer sent more than the quoted amount         | Reconcile / refund the excess                    |
| `payment.expired`    | The payment window closed unpaid               | Release the cart / mark abandoned                |
| `payment.canceled`   | Buyer cancelled in the widget                  | Release the cart                                 |

Subscription events (`subscription.created`, `.activated`, `.renewed`, `.past_due`, `.expired`,
`.canceled`, `.reminder`) fire when a buyer checks out one of the store's **recurring prices** —
key fulfilment off them: grant access on `.activated`/`.renewed`, revoke on `.expired`, and use the
event's `metadata` (echoed from the checkout) to find your own user. Their `data` carries
`subscriptionId`, `storeId`, `mode`, `priceId`, `status`, `network`, `token`, `amount`, `interval`,
`buyerEmail`, `nextDueAt`, `renewUrl`, `metadata`, and `daysUntilDue` on reminders. HashPay emails
the buyer the reminders and hosted renew link (never an auto-charge).

## `data` on a payment event

| Field                  | Notes                                                                    |
|------------------------|--------------------------------------------------------------------------|
| `paymentId`            | HashPay's id for the payment                                             |
| `accountId`, `storeId` | Who it belongs to                                                        |
| `mode`                 | `"live"` or `"test"` — **test payments fire real webhooks**              |
| `network`, `token`     | e.g. `base`, `usdc`                                                     |
| `address`              | The receiving wallet (the seller's own)                                 |
| `amount`               | Display string, e.g. `"19.99"` — for humans                             |
| `amountBaseUnits`      | Integer as a **string** — the exact value; compare/persist **this**      |
| `decimals`             | Token decimals (6 everywhere except BSC, where USDC/USDT are 18)         |
| `txHash`, `blockNumber`| The settling transfer                                                    |
| `status`               | Upper-case enum, e.g. `CONFIRMED`                                       |
| `metadata`             | Whatever you attached at checkout — **your correlation handle**          |
| `originHost`           | Present when the checkout came from a browser origin                    |
| `confirmations`        | Present once > 0                                                        |

`payment.underpaid` / `payment.overpaid` add `expectedAmount`, `receivedAmount`, and
`receivedAmountBaseUnits`.

Never do money math on `amount` (a decimal string, and floats lose cents). Use `amountBaseUnits` —
integer, exact — and pair it with `decimals` if you must display it.

`metadata` is how a payment ties back to the seller's own order. Set it at checkout
(`{"orderId":"…"}`); it round-trips here untouched. For server-driven checkout sessions HashPay also
stamps the `sessionId` into `metadata` for exactly this purpose.

## The rules

**1. Verify the signature over the RAW body.** The HMAC is computed over the exact bytes on the
wire. A body that has been parsed into a dict and re-serialized will **not** match — key order and
whitespace change. In Express this means `express.raw({type:'application/json'})` on the route
*before* any global `express.json()`; in FastAPI, `await request.body()`. Get this wrong and every
signature fails, or (worse) you "fix" it by not verifying at all.

**2. Reject stale timestamps.** The `t` in the header is bound into the signature, which is what
makes a replay detectable. Reject anything outside a **5-minute** tolerance. `t` is the *send* time,
and a retry is re-signed fresh, so a legitimate retry never ages out of the window.

**3. Accept *any* `v1`, in constant time.** During a rotation a store has **two** active secrets and
the header then carries two `v1` entries; a receiver holding either one must verify, so no delivery
is dropped mid-rotation. Compare with a constant-time primitive (`crypto.timingSafeEqual`,
`hmac.compare_digest`) — a `==` on an HMAC leaks it a byte at a time.

**4. Dedupe on the event id.** Redeliveries are expected and normal: a retry after your 500, a
network blip, or a status that gets published twice by parallel producers. The `id` is stable across
all of them. Claim it atomically (a unique index / `INSERT … ON CONFLICT DO NOTHING` / `SETNX`) and
drop the event if it was already claimed. **Delivery is at-least-once; the id is what makes your
processing exactly-once.**

**5. Fulfil only on `payment.confirmed`, and only when `mode === "live"`.** `payment.detected` means
"a transfer appeared", not "the money is yours" — a reorg can still take it away. And test-mode
payments send real webhooks to your real endpoint, so a handler that doesn't check `mode` will ship
goods for a simulated payment.

**6. Return 2xx fast, then do the work.** HashPay gives the request **15 seconds** and treats any
non-2xx (or timeout) as a failure. A slow handler doesn't just stall — it manufactures duplicate
deliveries. Ack first, process after (background task / queue).

**7. Ignore unknown event types, and don't assume order.** New types get added; an unrecognised one
must be a no-op `200`, not a 400. Deliveries are not ordered — `payment.detected` can land *after*
`payment.confirmed` when the first attempt is retried. Make each handler independent of the others
rather than building a state machine that assumes a sequence.

## Verifying the signature

```
header:  t=1751456773,v1=5257a869e7ec…[,v1=…]
signed:  "<t>" + "." + <raw body bytes>
each v1: hex( HMAC-SHA256(secret = whsec_…, message = signed) )
```

1. Split the header on `,` into `t=…` and one or more `v1=…`.
2. Reject if `|now − t| > 300s`.
3. Build `signed = t + "." + rawBody`.
4. For each of your active secrets compute the hex HMAC-SHA256 and constant-time-compare it against
   each `v1`. Any match ⇒ authentic.
5. No match ⇒ **400 and stop.** Do not parse, log, or act on an unverified body.

Fail closed: with no secret configured, verification must return false, not skip.

## What happens when the handler fails

A non-2xx or a timeout is retried with backoff — 30s, 2m, 10m, 30m, 1h, 2h, 4h, 8h, then every 8h —
for up to **72 hours** (max 20 attempts), after which the delivery is marked **dead** and dropped.
Failures are therefore survivable: fix the endpoint inside 72h and the event still lands.

Inspect exactly what was sent and what came back:

```bash
curl -s "https://api.hashpay.dev/v1/stores/$STORE/webhook/deliveries" \
  -H "Authorization: Bearer $SK"
```

The last 50 rows, each with status, attempt count, the last HTTP status/error, the next retry time,
and the full payload — the first place to look when "the webhook isn't firing".

## Trust, but verify (optional Layer 2)

The signature already proves the event came from HashPay. For high-value fulfilment you can
additionally re-fetch the payment server-side before shipping:

```bash
curl -s https://api.hashpay.dev/v1/payments/$PAYMENT_ID -H "Authorization: Bearer $SK"
```

With a secret key the re-fetch is **scoped**: the key must belong to the store that owns the payment
(a foreign id answers `404`), and a revoked key fails loudly with `401 invalid_key` instead of
silently degrading to the public buyer view. The response body is the same one the public endpoint
returns, and the on-chain re-check is throttled either way — the value here is the scoping and the
loud failure, not a "fresher" answer.

## Testing it without real money

The endpoint must be a **public HTTPS URL** — HashPay refuses private/internal hosts
(`400 invalid_url`), so `localhost` will not register. For local development, expose the port with a
tunnel (`cloudflared tunnel --url http://localhost:3000`, `ngrok http 3000`) and register the tunnel
URL.

Then drive a full test-mode payment end to end:

```bash
# 1. Create a test checkout (test mode accepts any Origin).
PAYMENT=$(curl -s -X POST https://api.hashpay.dev/v1/checkout \
  -H "Origin: https://anything.example" \
  -d '{"publishableKey":"'$PK_TEST'","network":"base","token":"usdc",
       "priceId":"'$PRICE'","metadata":{"orderId":"test-1"}}' | jq -r .paymentId)

# 2. Settle it — fires the real webhooks at your endpoint.
curl -s -X POST https://api.hashpay.dev/v1/test/payments/$PAYMENT/simulate

# 3. See what your endpoint actually answered.
curl -s "https://api.hashpay.dev/v1/stores/$STORE/webhook/deliveries" -H "Authorization: Bearer $SK" | jq
```

A green run is: `payment.confirmed` in the delivery log with HTTP 200, and the order fulfilled
exactly once in the seller's database — then re-run step 2's delivery (or replay the same body) and
confirm the order is **not** fulfilled twice.

## Pitfalls that bite

- **Re-serialized body** → every signature fails. Verify raw bytes. (Rule 1.)
- **A global `express.json()` mounted before the webhook route** — same thing, and the usual cause.
- **Fulfilling on `payment.detected`** → goods shipped for money that can still vanish.
- **No `mode` check** → a test payment ships a real order.
- **No dedupe** → the buyer is charged once and fulfilled three times.
- **Heavy work before the ack** → 15s timeout → retries → duplicates.
- **`==` on the HMAC** → timing side-channel. Use the constant-time compare.
- **Only checking the first `v1`** → deliveries drop the moment a secret is rotated.
