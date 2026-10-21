// HashPay webhook receiver — Node / Express.
//
// Adapt the two TODOs (claimOnce, fulfil) to the host app's database. Everything above them —
// signature verification, replay window, idempotency, fast ack — should be copied as-is.
//
// Register the endpoint with:
//   PUT /v1/stores/{storeId}/webhook  {"url":"https://your.app/hashpay/hooks"}
// and put the whsec_… it returns (once!) in HASHPAY_WEBHOOK_SECRETS.

const crypto = require('crypto');
const express = require('express');

const app = express();

// Every *active* signing secret, comma-separated. During a rotation a store has two — accepting
// either is what lets you roll a new secret out without dropping deliveries.
const SECRETS = (process.env.HASHPAY_WEBHOOK_SECRETS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Reject deliveries whose timestamp is older than this. The timestamp is signed, so a replayed
// body cannot have its `t` rewritten — bounding `t` is what bounds the replay.
const TOLERANCE_SECONDS = 300;

/**
 * Verify `X-HashPay-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` against the RAW request body.
 * The signed message is exactly `<t>.<raw body>`.
 */
function verify(rawBody, header) {
  if (!header || SECRETS.length === 0) {
    return false; // fail closed — an unconfigured receiver must reject, not wave through
  }

  let t = null;
  const sent = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') t = value;
    else if (key === 'v1') sent.push(value); // one v1 per active secret — check them all
  }
  if (!t || sent.length === 0) {
    return false;
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    return false;
  }

  // Concatenate as BYTES, not as a string: rawBody must not round-trip through a JSON parse.
  const signed = Buffer.concat([Buffer.from(`${t}.`, 'utf8'), rawBody]);

  return SECRETS.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    const want = Buffer.from(expected, 'utf8');
    return sent.some((candidate) => {
      const got = Buffer.from(candidate, 'utf8');
      // timingSafeEqual throws on a length mismatch, so length-check first.
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    });
  });
}

// express.raw — NOT express.json. The HMAC covers the bytes on the wire; a parsed-and-reserialized
// body will never match. If the app mounts a global express.json(), this route must come first.
app.post('/hashpay/hooks', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verify(req.body, req.get('X-HashPay-Signature'))) {
    return res.status(400).send('bad signature'); // do not parse or log an unverified body
  }

  const event = JSON.parse(req.body.toString('utf8'));

  // Ack first. HashPay allows 15s and retries anything non-2xx — a slow handler doesn't just
  // stall, it manufactures duplicate deliveries. The real work happens after the response.
  res.status(200).send('ok');

  handle(event).catch((err) => console.error('[hashpay] handler failed', event.id, err));
});

async function handle(event) {
  // event.id is the idempotency key (mirrored in X-HashPay-Delivery, and signed). It is derived
  // from the state transition, so a redelivery carries the SAME id. Delivery is at-least-once;
  // this claim is what makes processing exactly-once.
  if (!(await claimOnce(event.id))) {
    return; // already handled
  }

  switch (event.type) {
    case 'payment.confirmed':
      // The only event that means the money is final. Fulfil here and nowhere else.
      await fulfil(event.data);
      break;

    case 'payment.detected':
      // Seen on-chain but not yet confirmed — a reorg can still take it away. Show "processing".
      break;

    case 'payment.underpaid':
    case 'payment.overpaid':
      // data.expectedAmount vs data.receivedAmount — reconcile or refund out of band.
      console.warn('[hashpay] inexact payment', event.data.paymentId,
        event.data.expectedAmount, '->', event.data.receivedAmount);
      break;

    case 'payment.expired':
    case 'payment.canceled':
      // Release the cart / mark the order abandoned.
      break;

    default:
      // Unknown or new event type (including every subscription.*): a no-op 200, never an error.
      break;
  }
}

async function fulfil(data) {
  // Test-mode payments fire real webhooks at this real endpoint. Without this guard a simulated
  // payment ships a real order.
  if (data.mode !== 'live') {
    return;
  }

  // Money is an integer in the token's base units, as a STRING. Never parse `data.amount`
  // (a decimal string) into a float — that loses cents.
  const paidBaseUnits = BigInt(data.amountBaseUnits);

  // `metadata` is whatever you attached at checkout — the handle back to your own order.
  const orderId = data.metadata?.orderId;

  // TODO: fulfil the order — and re-check the amount against what you expected before you ship.
  console.log('[hashpay] confirmed', data.paymentId, orderId, paidBaseUnits.toString(),
    data.token, 'on', data.network, 'tx', data.txHash);
}

/**
 * Atomically claim an event id, returning false if it was already claimed.
 *
 * TODO: back this with the app's datastore — a UNIQUE column and
 * `INSERT … ON CONFLICT DO NOTHING` (rowCount === 1 ⇒ first time), or Redis `SET id 1 NX`.
 * The in-memory Set below is correct only for a single process and is lost on restart.
 */
const seen = new Set();
async function claimOnce(eventId) {
  if (seen.has(eventId)) {
    return false;
  }
  seen.add(eventId);
  return true;
}

if (require.main === module) {
  app.listen(3000, () => console.log('listening on :3000'));
}

module.exports = { app, verify, handle };
