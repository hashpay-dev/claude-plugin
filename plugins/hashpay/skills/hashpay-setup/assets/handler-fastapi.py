"""HashPay webhook receiver — Python / FastAPI.

Adapt the two TODOs (claim_once, fulfil) to the host app's database. Everything above them —
signature verification, replay window, idempotency, fast ack — should be copied as-is.

Register the endpoint with:
    PUT /v1/stores/{storeId}/webhook  {"url":"https://your.app/hashpay/hooks"}
and put the whsec_… it returns (once!) in HASHPAY_WEBHOOK_SECRETS.

The same verify() works unchanged under Flask (`request.get_data()`) or Django
(`request.body`) — only the framework glue differs.
"""

from __future__ import annotations  # so the `str | None` hints below work on Python 3.7+

import hashlib
import hmac
import json
import logging
import os
import time

from fastapi import BackgroundTasks, FastAPI, Request, Response

app = FastAPI()
log = logging.getLogger("hashpay")

# Every *active* signing secret, comma-separated. During a rotation a store has two — accepting
# either is what lets you roll a new secret out without dropping deliveries.
SECRETS = [s.strip() for s in os.environ.get("HASHPAY_WEBHOOK_SECRETS", "").split(",") if s.strip()]

# Reject deliveries whose timestamp is older than this. The timestamp is signed, so a replayed
# body cannot have its `t` rewritten — bounding `t` is what bounds the replay.
TOLERANCE_SECONDS = 300


def verify(raw_body: bytes, header: str | None) -> bool:
    """Verify `X-HashPay-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` against the RAW request body.

    The signed message is exactly `<t>.<raw body>`.
    """
    if not header or not SECRETS:
        return False  # fail closed — an unconfigured receiver must reject, not wave through

    timestamp: str | None = None
    sent: list[str] = []
    for part in header.split(","):
        key, _, value = part.partition("=")
        key, value = key.strip(), value.strip()
        if key == "t":
            timestamp = value
        elif key == "v1":
            sent.append(value)  # one v1 per active secret — check them all
    if not timestamp or not sent:
        return False

    try:
        age = abs(int(time.time()) - int(timestamp))
    except ValueError:
        return False
    if age > TOLERANCE_SECONDS:
        return False

    # Concatenate as BYTES: raw_body must not round-trip through a JSON parse.
    signed = timestamp.encode("ascii") + b"." + raw_body

    for secret in SECRETS:
        expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
        # compare_digest, not == : a plain compare leaks the HMAC a byte at a time.
        if any(hmac.compare_digest(expected, candidate) for candidate in sent):
            return True
    return False


@app.post("/hashpay/hooks")
async def hashpay_hooks(request: Request, background: BackgroundTasks) -> Response:
    # await request.body() gives the RAW bytes. Do not use a parsed model here: the HMAC covers
    # the bytes on the wire, and a re-serialized body will never match.
    raw = await request.body()

    if not verify(raw, request.headers.get("X-HashPay-Signature")):
        # Do not parse or log an unverified body.
        return Response(content="bad signature", status_code=400)

    event = json.loads(raw)

    # Ack first, work after. HashPay allows 15s and retries anything non-2xx — a slow handler
    # doesn't just stall, it manufactures duplicate deliveries.
    background.add_task(handle, event)
    return Response(content="ok", status_code=200)


def handle(event: dict) -> None:
    # event["id"] is the idempotency key (mirrored in X-HashPay-Delivery, and signed). It is
    # derived from the state transition, so a redelivery carries the SAME id. Delivery is
    # at-least-once; this claim is what makes processing exactly-once.
    if not claim_once(event["id"]):
        return  # already handled

    kind = event["type"]
    data = event["data"]

    if kind == "payment.confirmed":
        # The only event that means the money is final. Fulfil here and nowhere else.
        fulfil(data)

    elif kind == "payment.detected":
        # Seen on-chain but not yet confirmed — a reorg can still take it away. Show "processing".
        pass

    elif kind in ("payment.underpaid", "payment.overpaid"):
        # expectedAmount vs receivedAmount — reconcile or refund out of band.
        log.warning("inexact payment %s: %s -> %s", data["paymentId"],
                    data["expectedAmount"], data["receivedAmount"])

    elif kind in ("payment.expired", "payment.canceled"):
        # Release the cart / mark the order abandoned.
        pass

    else:
        # Unknown or new event type (including every subscription.*): a no-op 200, never an error.
        pass


def fulfil(data: dict) -> None:
    # Test-mode payments fire real webhooks at this real endpoint. Without this guard a simulated
    # payment ships a real order.
    if data.get("mode") != "live":
        return

    # Money is an integer in the token's base units, as a STRING. Never float() `data["amount"]`
    # (a decimal string) — that loses cents.
    paid_base_units = int(data["amountBaseUnits"])

    # `metadata` is whatever you attached at checkout — the handle back to your own order.
    order_id = (data.get("metadata") or {}).get("orderId")

    # TODO: fulfil the order — and re-check the amount against what you expected before shipping.
    log.info("confirmed %s order=%s %d %s on %s tx=%s", data["paymentId"], order_id,
             paid_base_units, data["token"], data["network"], data["txHash"])


_seen: set[str] = set()


def claim_once(event_id: str) -> bool:
    """Atomically claim an event id, returning False if it was already claimed.

    TODO: back this with the app's datastore — a UNIQUE column and
    `INSERT … ON CONFLICT DO NOTHING` (rowcount == 1 ⇒ first time), or Redis `SET id 1 NX`.
    The in-memory set below is correct only for a single process and is lost on restart.
    """
    if event_id in _seen:
        return False
    _seen.add(event_id)
    return True
