"""Offline Stripe TEST-contract regression, signed by the real Stripe SDK.

Uses a synthetic whsec, fake sk_test prefix and local stubbed provider calls.
It NEVER contacts Stripe and is NOT a live Stripe sandbox E2E certification.
"""
import hashlib
import hmac
import json
import time
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import select, func

from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app
from app.stripe_gateway import money_cents


def _setup(monkeypatch):
    monkeypatch.setattr(settings, "stripe_enabled", True)
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_test_synthetic_unusable_ci")
    monkeypatch.setattr(settings, "stripe_publishable_key", "pk_test_synthetic_unusable_ci")
    monkeypatch.setattr(settings, "stripe_webhook_secret", "whsec_synthetic_only_not_live")
    monkeypatch.setattr(settings, "stripe_connect_enabled", False)


def _login(c, email, password):
    r = c.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["access_token"]}


def _order(c):
    customer = _login(c, "cliente@talaeats.mx", "Cliente123!")
    item = c.get("/api/v1/restaurants/1").json()["menu_items"][0]
    ref = "qa-stripe-" + uuid.uuid4().hex
    r = c.post("/api/v1/orders", headers=customer, json={
        "restaurant_id": 1, "address": "Tala, Jalisco QA",
        "order_type": "pickup", "payment_method": "stripe",
        "client_reference": ref, "items": [{"menu_item_id": item["id"], "quantity": 1}]
    })
    assert r.status_code == 201, r.text
    return r.json()


def _send(c, typ, obj, *, event_id=None, valid=True, live=False):
    event_id = event_id or ("evt_CI_" + uuid.uuid4().hex)
    event = {"id": event_id, "object": "event", "type": typ, "livemode": live,
             "data": {"object": obj}}
    payload = json.dumps(event, separators=(",", ":"), sort_keys=True).encode()
    timestamp = str(int(time.time()))
    digest = hmac.new(settings.stripe_webhook_secret.encode(),
                      timestamp.encode() + b"." + payload, hashlib.sha256).hexdigest()
    if not valid:
        digest = "0" * 64
    return c.post("/api/v1/payments/stripe/webhook", content=payload,
                  headers={"Stripe-Signature": "t=" + timestamp + ",v1=" + digest})


def _refund_entries(order_id):
    with SessionLocal() as db:
        return db.scalar(select(func.count(models.FinancialLedgerEntry.id)).where(
            models.FinancialLedgerEntry.order_id == order_id,
            models.FinancialLedgerEntry.kind == "refund"
        ))


def test_real_stripe_signature_verification_duplicate_and_refund_delta(monkeypatch):
    _setup(monkeypatch)
    with TestClient(app) as c:
        order = _order(c)
        oid = order["id"]
        amount = money_cents(order["total"])
        pi = "pi_QaSignature_" + uuid.uuid4().hex
        payment = {"id": pi, "object": "payment_intent", "currency": "mxn",
                   "amount": amount, "amount_received": amount,
                   "metadata": {"tala_order_id": str(oid)}}
        assert _send(c, "payment_intent.succeeded", payment, valid=False).status_code == 400
        assert _send(c, "payment_intent.succeeded", payment, live=True).status_code == 400

        event_id = "evt_QaSuccess_" + uuid.uuid4().hex
        paid = _send(c, "payment_intent.succeeded", payment, event_id=event_id)
        assert paid.status_code == 200, paid.text
        assert paid.json()["handled"] is True
        same = _send(c, "payment_intent.succeeded", payment, event_id=event_id)
        assert same.status_code == 200 and same.json()["duplicate"] is True

        charge = {"id": "ch_Qa_" + uuid.uuid4().hex, "object": "charge",
                  "payment_intent": pi, "amount_refunded": amount // 2}
        partial = _send(c, "charge.refunded", charge)
        assert partial.status_code == 200, partial.text
        assert _refund_entries(oid) == 2

        # A distinct refund webhook describing the SAME cumulative amount must
        # not create further financial entries.
        again = _send(c, "charge.refunded", charge)
        assert again.status_code == 200 and _refund_entries(oid) == 2
        charge["amount_refunded"] = amount
        full = _send(c, "charge.refunded", charge)
        assert full.status_code == 200, full.text
        assert _refund_entries(oid) == 4

        with SessionLocal() as db:
            result = db.get(models.Order, oid)
            assert result.payment_status == "refunded"
            assert money_cents(result.refunded_amount) == amount


def test_refund_requires_admin_and_provider_is_idempotent(monkeypatch):
    _setup(monkeypatch)
    from app.routes import stripe_payments
    calls = []
    def fake_refund(client, pi, amount, key):
        calls.append((pi, amount, key))
        return {"id": "re_qa_refund_1", "status": "succeeded"}
    monkeypatch.setattr(stripe_payments, "stripe_client", lambda: object())
    monkeypatch.setattr(stripe_payments, "refund_create", fake_refund)

    with TestClient(app) as c:
        order = _order(c)
        oid = order["id"]
        pi = "pi_QaAdmin_" + uuid.uuid4().hex
        amount = money_cents(order["total"])
        payment = {"id": pi, "object": "payment_intent", "currency": "mxn",
                   "amount": amount, "amount_received": amount,
                   "metadata": {"tala_order_id": str(oid)}}
        assert _send(c, "payment_intent.succeeded", payment).status_code == 200
        customer = _login(c, "cliente@talaeats.mx", "Cliente123!")
        assert c.post(f"/api/v1/payments/stripe/admin/orders/{oid}/refund",
                      headers=customer).status_code in (401, 403)
        admin = _login(c, "admin@talaeats.mx", "Admin123!")
        first = c.post(f"/api/v1/payments/stripe/admin/orders/{oid}/refund", headers=admin)
        assert first.status_code == 200, first.text
        second = c.post(f"/api/v1/payments/stripe/admin/orders/{oid}/refund", headers=admin)
        assert second.status_code == 200 and second.json()["already_refunded"] is True
        assert len(calls) == 1
        assert calls[0][2] == f"tala:stripe:refund:v1:{oid}"
        assert _refund_entries(oid) == 2
