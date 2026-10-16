"""F2.07 Stripe refund ordering: fake provider + locally signed webhook.

No Stripe TEST/LIVE network or credentials are used. These tests do not
certify a real PSP settlement or permit withdrawals.
"""
from decimal import Decimal
import hashlib
import hmac
import json
import time
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app
from app.stripe_gateway import money_cents


def setup(monkeypatch):
    monkeypatch.setattr(settings, "stripe_enabled", True)
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_test_f207_fake_local_only")
    monkeypatch.setattr(settings, "stripe_webhook_secret", "whsec_f207_offline_only")
    monkeypatch.setattr(settings, "withdrawals_execution_enabled", False)
    monkeypatch.setattr(settings, "withdrawals_live_enabled", False)
    monkeypatch.setattr("app.routes.stripe_payments.stripe_client", lambda: object())
    monkeypatch.setattr(
        "app.routes.stripe_payments.refund_create",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("Forbidden duplicate refund request")),
    )


def make_order(client):
    login = client.post("/api/v1/auth/login", json={
        "email": "cliente@talaeats.mx", "password": "Cliente123!"})
    assert login.status_code == 200
    token = {"Authorization": "Bearer " + login.json()["access_token"]}
    item = client.get("/api/v1/restaurants/1").json()["menu_items"][0]
    order = client.post("/api/v1/orders", headers=token, json={
        "restaurant_id": 1, "address": "QA Calle Principal, Tala",
        "payment_method": "stripe", "order_type": "pickup",
        "client_reference": "f207-stripe-" + uuid4().hex,
        "items": [{"menu_item_id": item["id"], "quantity": 1}],
    })
    assert order.status_code == 201, order.text
    out = order.json()
    intent = f"pi_f207_{out['id']}"
    with SessionLocal() as db:
        row = db.get(models.Order, out["id"])
        row.payment_provider_id = intent
        row.payment_preference_id = intent
        row.payment_status = "paid"
        db.commit()
    return out, intent


def emit(client, monkeypatch, *, typ, event_id, obj):
    monkeypatch.setattr("app.routes.stripe_payments.parse_webhook",
                        lambda *args, **kwargs: {
                            "id": event_id, "type": typ, "livemode": False,
                            "data": {"object": obj}})
    return client.post("/api/v1/payments/stripe/webhook",
                       content=b"{}", headers={"stripe-signature": "mock"})


def snapshot(oid):
    with SessionLocal() as db:
        row = db.get(models.Order, oid)
        refunds = db.scalars(select(models.FinancialLedgerEntry).where(
            models.FinancialLedgerEntry.order_id == oid,
            models.FinancialLedgerEntry.kind == "refund")).all()
        return row.payment_status, row.status, Decimal(row.refunded_amount or 0), len(refunds)


def test_full_refund_then_stale_partial_cannot_reopen(monkeypatch):
    setup(monkeypatch)
    with TestClient(app) as c:
        order, pi = make_order(c)
        total = money_cents(Decimal(str(order["total"])))
        full = emit(c, monkeypatch, typ="charge.refunded", event_id="evt_f207_stripe_full",
                    obj={"payment_intent": pi, "amount_refunded": total})
        assert full.status_code == 200, full.text
        original = snapshot(order["id"])
        assert original[0] == "refunded" and original[2] == Decimal(str(order["total"]))
        assert original[3] > 0
        stale = emit(c, monkeypatch, typ="charge.refunded", event_id="evt_f207_stripe_stale",
                     obj={"payment_intent": pi, "amount_refunded": total // 2})
        assert stale.status_code == 200, stale.text
        assert snapshot(order["id"]) == original
        replay = emit(c, monkeypatch, typ="charge.refunded", event_id="evt_f207_stripe_stale",
                      obj={"payment_intent": pi, "amount_refunded": total // 2})
        assert replay.status_code == 200 and replay.json().get("duplicate") is True


def test_dispute_cannot_be_cleared_by_partial_refund(monkeypatch):
    setup(monkeypatch)
    with TestClient(app) as c:
        order, pi = make_order(c)
        total = money_cents(Decimal(str(order["total"])))
        dispute = emit(c, monkeypatch, typ="charge.dispute.created",
                       event_id="evt_f207_dispute",
                       obj={"payment_intent": pi})
        assert dispute.status_code == 200, dispute.text
        partial = emit(c, monkeypatch, typ="charge.refunded",
                       event_id="evt_f207_dispute_partial",
                       obj={"payment_intent": pi, "amount_refunded": total // 2})
        assert partial.status_code == 200, partial.text
        state, _, refunded, count = snapshot(order["id"])
        assert state == "disputed" and refunded > 0 and count > 0
        stale = emit(c, monkeypatch, typ="payment_intent.succeeded",
                     event_id="evt_f207_dispute_late_paid",
                     obj={"id": pi, "currency": "mxn", "amount": total,
                          "metadata": {"tala_order_id": str(order["id"])}})
        assert stale.status_code == 200
        assert snapshot(order["id"])[0] == "disputed"


def test_already_refunded_late_succeeded_never_calls_stripe_refund(monkeypatch):
    setup(monkeypatch)
    with TestClient(app) as c:
        order, pi = make_order(c)
        total = money_cents(Decimal(str(order["total"])))
        refund = emit(c, monkeypatch, typ="charge.refunded",
                      event_id="evt_f207_full_before_success",
                      obj={"payment_intent": pi, "amount_refunded": total})
        assert refund.status_code == 200
        before = snapshot(order["id"])
        later = emit(c, monkeypatch, typ="payment_intent.succeeded",
                     event_id="evt_f207_paid_after_refund",
                     obj={"id": pi, "currency": "mxn", "amount": total,
                          "metadata": {"tala_order_id": str(order["id"])}})
        assert later.status_code == 200, later.text
        assert snapshot(order["id"]) == before


def test_real_local_hmac_signature_not_a_provider_sandbox_credential(monkeypatch):
    setup(monkeypatch)
    # Exercise stripe.Webhook.construct_event via the actual local SDK and
    # a synthetic whsec. No calls to Stripe API or a bank occur.
    with TestClient(app) as c:
        order, pi = make_order(c)
        total = money_cents(Decimal(str(order["total"])))
        event = {"id": "evt_f207_real_hmac_local", "object": "event",
                 "created": int(time.time()), "livemode": False,
                 "type": "payment_intent.succeeded",
                 "data": {"object": {"id": pi, "object": "payment_intent",
                                     "currency": "mxn", "amount": total,
                                     "metadata": {"tala_order_id": str(order["id"])}}}}
        payload = json.dumps(event, separators=(",", ":")).encode()
        stamp = str(int(time.time()))
        digest = hmac.new(settings.stripe_webhook_secret.encode(),
                          stamp.encode() + b"." + payload, hashlib.sha256).hexdigest()
        signature = f"t={stamp},v1={digest}"
        # Parse and verify using the real SDK-backed gateway function.
        good = c.post("/api/v1/payments/stripe/webhook", content=payload,
                      headers={"stripe-signature": signature})
        assert good.status_code == 200, good.text
        bad_payload = payload.replace(b"payment_intent.succeeded", b"payment_intent.canceled")
        bad = c.post("/api/v1/payments/stripe/webhook", content=bad_payload,
                     headers={"stripe-signature": signature})
        assert bad.status_code == 400
