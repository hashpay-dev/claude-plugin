---
name: hashpay-setup
description: Set up and integrate HashPay — non-custodial USDC/USDT payments that settle straight to the seller's own wallets — end to end over HTTP with only a secret API key (sk_live_… / sk_test_…). Covers the account, stores, receiving wallets, the webhook endpoint and the handler that receives payment events, products/prices/payment links, the checkout embed, and a verified test payment. Use when asked to set up, configure, integrate, script, or automate HashPay, or to check or finish an existing HashPay setup.
---

# Set up HashPay with a secret key

HashPay lets a site accept USDC and USDT on eight chains, with every payment going **straight to the
seller's own wallet** — HashPay never holds funds or keys. Every part of an account is configurable
over HTTP with one **secret API key**; this skill walks you through it from an empty account to a
proven, live-ready integration.

Machine-readable contract: `https://api.hashpay.dev/openapi.json` (OpenAPI 3.1). Human docs:
`https://hashpay.dev/docs`. When this file and the API disagree, the API wins — say so to the seller.

## Bundled files

| File | Use it for |
|------|------------|
| `references/webhook-handler.md` | **Read before writing any webhook receiver.** Event catalog, payload shape, signature scheme, the rules a correct handler follows. |
| `assets/handler-express.js` | Working Node/Express receiver — copy and adapt. |
| `assets/handler-fastapi.py` | Working Python/FastAPI receiver — copy and adapt. |

## What only the seller can give you

Ask for these up front; you can't produce any of them yourself.

1. **An account.** They sign up at `https://app.hashpay.dev` (Google, or email + password — then they
   must click the verification link; live keys answer `403 email_unverified` until they do).
2. **A live secret key.** Dashboard → **Integration** (Live mode) → **Create** under *Secret key*;
   it's shown once. Ask them to put it in an environment variable (e.g.
   `export HASHPAY_SECRET_KEY=sk_live_…`) rather than pasting it into the conversation, and refer to it
   as `$SK` / `$HASHPAY_SECRET_KEY`. An `sk_test_` key can do everything **except** change receiving
   wallets, the webhook endpoint or its secrets, or live keys (`403 live_key_required`) — fine for
   exploring, not for a full setup.
3. **Their receiving wallet addresses** — see Step 3. Never invent, derive, or "correct" one.
4. **Where their site and backend code live**, if you're also writing the webhook handler and embed.

## Ground rules

- **Base URL:** `https://api.hashpay.dev/v1` — unless the environment sets `HASHPAY_API_BASE` (a local
  or staging server), in which case use that. **Auth on every request:** `Authorization: Bearer $SK`.
- **Never print, log, or commit the key** (or any `whsec_` webhook secret). Read it from the
  environment; put secrets the app needs into its own secret store / `.env`, never into source.
- **Key kinds:** `pk_` publishable (browser), `sk_` secret (configures the **whole account** — every
  store, wallets, keys — treat each as a production credential), and `rk_` restricted (a server's
  runtime key: checkout sessions + payment re-fetch only; on anything else it answers
  `403 insufficient_scope`). `sk_test_` keys are refused (`403 live_key_required`) on wallets, the
  webhook endpoint and secrets, and live keys.
- **Retries:** send `Idempotency-Key: <uuid>` on every `POST`. A retry with the same key within 24h
  replays the first response (header `Idempotent-Replayed: true`) instead of creating a second store,
  price or key. Same key with a different body → `409 idempotency_key_reused`; still running →
  `409 idempotency_in_progress` (wait and retry). 5xx responses aren't stored, so retrying after one
  re-executes.
- **Errors** are `{"error": {"code": "...", "message": "..."}}`. `401 unauthorized` = bad/revoked key;
  `403 account_disabled`; a store outside the key's account answers `404 store_not_found` — list
  the ones it can use with `GET /v1/stores` rather than guessing ids.
- **Shown-once secrets:** `sk_` keys and `whsec_` signing secrets appear in plaintext exactly once, in
  the response that mints them. Capture them immediately; afterwards only a masked `display`
  (`sk_live_••••wxyz`) is listed. Publishable keys (`pk_`) aren't secret and list in full.
- **Money** on this surface (prices, sessions, plan fees) is **integer USD cents** (`unitAmountCents`,
  `amountCents`). On-chain decimals are handled server-side — never convert yourself.
- **Networks:** `ethereum`, `polygon`, `avalanche`, `bsc`, `arbitrum`, `base`, `tron`, `solana`.
  **Tokens:** `usdc`, `usdt`. Valid pairs come back in `supportedPairs` on `GET /v1/me`.
- **Security notices:** every change to a receiving wallet, the webhook endpoint, a webhook signing
  secret or an API key emails the account owner's sign-in address (`securityEmail` on `GET /v1/me`),
  naming the key that made it. They can't be turned off. Tell the seller to expect a few during setup.

## Step 0 — verify the key, find the store, resume

```bash
curl -s https://api.hashpay.dev/v1/me -H "Authorization: Bearer $SK"
curl -s https://api.hashpay.dev/v1/stores -H "Authorization: Bearer $SK"
curl -s https://api.hashpay.dev/v1/stores/$STORE/setup -H "Authorization: Bearer $SK"
```

`/v1/me` returns `accountId`, the profile, `status`, `emailVerified`, `securityEmail`, `tier`,
`usage`, and `supportedPairs`. Every account starts with one store (`Default store`); use it unless
the seller wants several.

`GET /v1/stores/{storeId}/setup` is the **checklist** — computed from live state on every call, so
use it to resume a half-done setup and to prove you finished:

```json
{"storeId":"store_…","readyForLive":true,"next":"webhook_endpoint","steps":[
  {"id":"email_verified","required":true,"done":true,"detail":"…"},
  {"id":"wallets","required":true,"done":true,"networks":["base","solana"],"detail":"…"},
  {"id":"webhook_endpoint","required":false,"done":false,"url":null,"activeSecrets":0,"detail":"…"},
  {"id":"test_payment","required":false,"done":false,"paymentId":null,"detail":"…"},
  {"id":"webhook_verified","required":false,"done":false,"lastConfirmedDelivery":null,"detail":"…"},
  {"id":"embed_installed","required":false,"done":false,"seenAt":null,"detail":"…"}]}
```

`readyForLive` means live checkout will work (verified email + a wallet). `next` is the first step
not done. Each `detail` says what's missing and which call fixes it. The "recommended" steps are what
a correct integration looks like; skip one only if the seller deliberately doesn't need it (e.g. a
seller using payment links alone, with no backend, has no webhook).

## Step 1 — account profile

```bash
curl -s -X PUT https://api.hashpay.dev/v1/account -H "Authorization: Bearer $SK" \
  -d '{"businessName":"Acme","supportEmail":"ops@acme.com","country":"US","website":"https://acme.com"}'
```

## Step 2 — stores (optional)

- `GET /v1/stores`, `POST /v1/stores` `{"name":"My shop"}` → 201 store summary,
  `GET`/`PUT /v1/stores/{storeId}` `{"name":…, "openAmountDisabled":true|false}`.
- A new store gets its four keys (pk/sk × test/live) but their plaintext is **not** returned — mint
  the ones you need in Step 6.
- `openAmountDisabled: true` is strict mode: the store refuses browser-supplied amounts and only sells
  server-defined prices and sessions. Recommend it whenever the seller only sells catalog items.

## Step 3 — receiving wallets (required)

Payments go straight to these addresses, and a wrong one loses every payment quoted on it —
irreversibly. A store can only quote a (network, token) it has a wallet for.

**Addresses come from the seller, verbatim.** Ask for them; never invent, derive, guess, or "fix"
one, and never reuse an address from an example or another project. Before posting, **read each
address back in full** and get an explicit yes. One EVM address is the same wallet on all six EVM
chains *if it's an ordinary wallet*; a smart-contract wallet (a Safe, for example) exists only on the
chains it was deployed to — ask which. Tron (`T…`) and Solana (base58) each need their own address.

- `POST /v1/stores/{storeId}/wallets` `{"network":"base","address":"0x…","label":"treasury"}`, or
  `{"networks":["ethereum","base","arbitrum"],"address":"0x…"}` to add one address on several networks
  in one call (one notice email instead of one per network). Send `network` or `networks`, not both.
  All-or-nothing → 201 store summary.
- `400 bad_address` — the reason is in `message`; relay it as-is. Checked: chain format; the EIP-55
  checksum for mixed-case `0x…`; Tron's base58check checksum; zero/burn addresses; Solana program ids;
  a USDC/USDT token contract or mint pasted in place of a wallet. A checksum failure means a character
  is wrong: ask the seller to copy the address again **from their wallet app** — never try variations.
  It **can't** catch a typo that forms another valid address (any Solana typo, an all-lowercase EVM
  one) — that's what the read-back is for.
- `409 duplicate_address` — already on this store.
- `POST /v1/stores/{storeId}/wallets/copy` `{"fromStoreId":"store_…"}` copies a sibling store's wallets.
- `GET /v1/stores/{storeId}/wallets`; `DELETE /v1/stores/{storeId}/wallets?network=base&address=0x…`
  (query params, not a body).

## Step 4 — webhook endpoint + handler

The webhook is the **only** authoritative signal that money arrived — the buyer can close the checkout
mid-payment, or pay long after leaving the page. An integration that fulfils orders anywhere else is
broken. Build and deploy the handler **before** registering it; registering an endpoint that isn't
live just burns 72 hours of retries.

### 4a. Build the handler

**Read `references/webhook-handler.md` first**, and start from `assets/handler-express.js` or
`assets/handler-fastapi.py` (complete, verified against real HashPay signatures) instead of writing
verification from scratch — it's the part integrations most reliably get subtly wrong. In short:

1. **Verify the signature over the RAW body bytes.** `X-HashPay-Signature: t=<unix>,v1=<hex>` carries
   one `v1` per active secret (two during a rotation), each `HMAC-SHA256("<t>.<raw body>")` in hex.
   Constant-time compare against **any** `v1`; reject `t` older than 5 minutes. A re-serialized JSON
   body never matches.
2. **Dedupe on the event `id`** (also sent as `X-HashPay-Delivery`) — delivery is at-least-once.
3. **Fulfil only on `payment.confirmed`, and only when `data.mode === "live"`.** `payment.detected`
   isn't settled money, and test payments fire real webhooks at the real endpoint.
4. **Return 2xx within 15s, then do the work.** Non-2xx is retried with backoff for 72h.
5. **Ignore unknown event types; don't assume ordering.**

### 4b. Register it

```bash
curl -s -X PUT https://api.hashpay.dev/v1/stores/$STORE/webhook \
  -H "Authorization: Bearer $SK" -d '{"url":"https://acme.com/hashpay/hooks"}'
```

- Must be a **public** URL (`400 invalid_url` otherwise; `localhost` won't register). For local
  development, expose the port with a tunnel (`cloudflared tunnel --url http://localhost:3000`,
  `ngrok http 3000`) and register that.
- The first registration returns `secretId` and the one-time `webhookSecret` (`whsec_…`): put it
  straight into the handler's secret store (e.g. `HASHPAY_WEBHOOK_SECRETS`), never into source.
- Rotation: `POST /v1/stores/{storeId}/webhook/secrets` → 201 with a one-time `secret` (at most 2
  active, `409 too_many_secrets`), deploy it, then `DELETE …/webhook/secrets/{secretId}` the old one.
- Debugging: `GET /v1/stores/{storeId}/webhook/deliveries?status=dead&type=payment.confirmed` — status,
  attempts, last HTTP status/error/response, next retry, and the exact payload.

## Step 5 — domains and branding (optional)

- Live checkout is **blacklist-only**: any origin may transact; a domain that produced a live payment
  is surfaced for review. `GET /v1/stores/{storeId}/domains`, `POST …/domains` `{"domain":"shop.acme.com"}`
  (allow-list it), `POST …/domains/accept` / `…/domains/reject`, `DELETE …/domains?domain=host`.
- Checkout look: `PUT /v1/stores/{storeId}/branding` `{"displayName":"Acme","logoUrl":"https://…","color":"#251160"}`.

## Step 6 — keys for the integration

- `GET /v1/stores/{storeId}/keys` → `keyId`, `kind` (`publishable`|`secret`), `mode` (`test`|`live`),
  masked `display`, `createdAt`.
- `POST /v1/stores/{storeId}/keys` `{"kind":"publishable","mode":"live"}` → 201 `{"key":"pk_live_…"}`,
  plaintext once. `DELETE /v1/stores/{storeId}/keys/{keyId}` revokes.
- The site needs a **publishable** key (`pk_test_` while testing, `pk_live_` in production).
- If the seller's backend calls HashPay (checkout sessions, payment re-fetch), mint it a
  **restricted** key — `{"kind":"restricted","mode":"live"}` → `rk_live_…` — and put that in the
  backend's secret store. It can't change wallets, keys or the webhook, so a leak can't redirect a
  payment. Never deploy the `sk_` the seller handed you.

## Step 7 — catalog: products → prices → payment links

Order matters: a price references a product; a payment link references a price.

- `POST /v1/stores/{storeId}/products` `{"name":"Pro plan","description":"…"}` → 201 `productId`.
  `PUT …/products/{productId}` partially updates `name`/`description`/`active`.
- `POST /v1/stores/{storeId}/prices`
  `{"productId":"prod_…","unitAmountCents":1999,"acceptedNetworks":["base","solana"],"acceptedTokens":["usdc"]}`
  → 201 `priceId`. Empty/omitted accepted-lists mean no restriction. **Prices are immutable except
  `active`**: to change an amount, create a new price and `PUT …/prices/{priceId}` `{"active":false}`
  on the old one. Add `"type":"recurring","interval":"month"` (or `"year"`) for a subscription price:
  checkout then collects the buyer's email and HashPay emails renewal links before each anniversary —
  never an auto-charge. `GET /v1/stores/{storeId}/subscriptions`, `POST …/subscriptions/{id}/cancel`.
- `POST /v1/stores/{storeId}/payment_links` `{"priceId":"price_…","collectEmail":true}` → 201
  `paymentLinkId` — a hosted checkout the seller can share without any code.

## Step 8 — put checkout on the site

```html
<script src="https://cdn.hashpay.dev/embed.js" data-pk="pk_live_…"></script>
<button data-hashpay-price="price_…">Pay with crypto</button>
<!-- or from JS: HashPay.checkout({ priceId: "price_…" }) -->
```

For server-decided amounts, the backend creates a session with its restricted key —
`POST /v1/checkout/sessions` `{"amountCents":4200,"successUrl":"https://…","metadata":{…}}` → 201
`sessionId` (24h) — and the page opens `HashPay.checkout({ sessionId })`. Poll
`GET /v1/checkout/sessions/{id}` until `status:"complete"` carries the `paymentId`, but fulfil from the
webhook. Use `pk_test_` until Step 9 passes.

## Step 9 — prove it in test mode (no real money)

1. With a `pk_test_` key, create a checkout the way the widget would (test mode accepts any origin):
   ```bash
   curl -s -X POST https://api.hashpay.dev/v1/checkout -H "Origin: https://anything.example" \
     -d '{"publishableKey":"'$PK_TEST'","network":"base","token":"usdc","priceId":"'$PRICE'"}'
   ```
   Exactly one of `amount` | `priceId` | `paymentLinkId` | `sessionId`.
2. Settle it: `POST /v1/test/payments/{paymentId}/simulate`.
3. `GET /v1/stores/{storeId}/setup` should now show `test_payment` and `webhook_verified` done — the
   latter only if the handler answered 2xx. Confirm the handler fulfilled **exactly once** (replaying a
   delivery must not fulfil twice), then swap in the `pk_live_` key.

## Billing (only if the seller asks)

`GET /v1/billing/plans` lists tiers and fees; `GET /v1/billing/usage` shows this month's volume
against the plan ceiling. `POST /v1/billing/subscribe` `{"tier":"starter","interval":"month","network":"base","token":"usdc"}`
returns a fee payment (`payTo`, `amount`, `amountBaseUnits`, `expiresAt`) that **the seller pays from
their own wallet** — you can't. Never subscribe without the seller asking.

## Finish

1. `GET /v1/stores/{storeId}/setup` — report each step to the seller in plain words, especially any
   step not done and why.
2. Tell them which keys you created and where you stored them, and remind them about the security
   emails they received.
3. Suggest they **revoke the secret key they handed you** (Integration page, or
   `DELETE /v1/stores/{storeId}/keys/{keyId}`): everything you deployed uses its own restricted or
   publishable key, so nothing depends on it.
