"""F2.07 Mercado Pago webhook ordering regressions with 100% fake PSP data.

These tests never call the network or use Mercado Pago TEST/LIVE credentials.
They guard local semantics only; F2.07 cannot be marked completed without
real Stripe TEST and Mercado Pago sandbox E2E evidence.
"""
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app


class FakeResponse:
    def __init__(self, body, status_code=200):
        self.body, self.status_code = body, status_code
        self.ok = status_code < 400

    def json(self):
        return self.body


@pytest.fixture
def psp(monkeypatch):
    monkeypatch.setattr(settings, "payment_provider", "mercadopago")
    monkeypatch.setattr(settings, "mercado_pago_access_token", "APP_USR_FAKE_F207_OFFLINE")
    monkeypatch.setattr(settings, "mercado_pago_webhook_secret", "")
    monkeypatch.setattr(settings, "mercado_pago_marketplace_fee_enabled", False)
    # Any unmocked HTTP call is forbidden by monkeypatching the gateway.
    monkeypatch.setattr("app.routes.payments.http_post", lambda *a, **kw:
                        (_ for _ in ()).throw(AssertionError("network forbidden")))
    monkeypatch.setattr("app.routes.payments.http_get", lambda *a, **kw:
                        (_ for _ in ()).throw(AssertionError("network forbidden")))
    return monkeypatch


def create_order(client):
    login = client.post("/api/v1/auth/login",
                        json={"email": "cliente@talaeats.mx", "password": "Cliente123!"})
    assert login.status_code == 200, login.text
    headers = {"Authorization": "Bearer " + login.json()["access_token"]}
    item = client.get("/api/v1/restaurants/1").json()["menu_items"][0]
    resp = client.post("/api/v1/orders", headers=headers, json={
        "restaurant_id": 1, "address": "Centro Tala synthetic", "payment_method": "mercadopago",
        "client_reference": "F207-" + uuid4().hex[:26],
        "order_type": "pickup", "items": [{"menu_item_id": item["id"], "quantity": 1}],
    })
    assert resp.status_code == 201, resp.text
    return resp.json(), headers


def notify(client, order, *, event="n-1", state="approved", paid_amount=None):
    payment_id = "f207-payment-" + str(order["id"])
    data = {"id": payment_id, "external_reference": str(order["id"]),
            "transaction_amount": float(paid_amount if paid_amount is not None else order["total"]),
            "status": state}
    return data, {
        "url": "/api/v1/payments/mercadopago/webhook?type=payment&data.id=" + payment_id,
        "json": {"id": event, "date_created": "2026-10-15T20:00:00Z",
                 "action": "payment.updated", "type": "payment",
                 "data": {"id": payment_id}},
    }


def records(order_id):
    with SessionLocal() as db:
        order = db.get(models.Order, order_id)
        return order.payment_status, order.status, order.refunded_amount


def test_approved_then_stale_pending_remains_paid_and_replay_idempotent(psp):
    with TestClient(app) as c:
        order, _ = create_order(c)
        approval, req = notify(c, order, event="f207-approved", state="approved")
        psp.setattr("app.routes.payments.http_get", lambda *a, **kw: FakeResponse(approval))
        first = c.post(**req)
        assert first.status_code == 200, first.text
        assert records(order["id"])[0] == "paid"
        pending, other = notify(c, order, event="f207-stale-pending", state="pending")
        psp.setattr("app.routes.payments.http_get", lambda *a, **kw: FakeResponse(pending))
        stale = c.post(**other)
        assert stale.status_code == 200, stale.text
        assert records(order["id"])[0] == "paid"
        retry = c.post(**req)
        assert retry.status_code == 200 and retry.json().get("duplicate") is True


@pytest.mark.parametrize("terminal,provider_state", [
    ("refunded", "approved"),
    ("refunded", "pending"),
    ("refunded", "rejected"),
    ("charged_back", "approved"),
])
def test_terminal_refund_or_chargeback_cannot_be_revived(psp, terminal, provider_state):
    with TestClient(app) as c:
        order, _ = create_order(c)
        pay, req = notify(c, order, event="f207-terminal-" + terminal + "-" + provider_state,
                          state=provider_state)
        with SessionLocal() as db:
            row = db.get(models.Order, order["id"])
            row.payment_provider_id = pay["id"]
            row.status = "cancelled"
            row.payment_status = terminal
            row.refunded_amount = Decimal(row.total)
            db.commit()
            notifications_before = db.scalar(select(func.count(models.Notification.id)))
        psp.setattr("app.routes.payments.http_get", lambda *a, **kw: FakeResponse(pay))
        res = c.post(**req)
        assert res.status_code == 200, res.text
        payment_status, order_status, refunded = records(order["id"])
        assert payment_status == terminal
        assert order_status == "cancelled"
        assert Decimal(refunded) == Decimal(str(order["total"]))
        with SessionLocal() as db:
            assert db.scalar(select(func.count(models.Notification.id))) == notifications_before


def test_provider_refund_legitimately_triggers_refund_once(psp):
    with TestClient(app) as c:
        order, _ = create_order(c)
        approved, req = notify(c, order, event="f207-first-paid", state="approved")
        psp.setattr("app.routes.payments.http_get", lambda *a, **kw: FakeResponse(approved))
        assert c.post(**req).status_code == 200
        refunded, refund_req = notify(c, order, event="f207-provider-refund", state="refunded")
        psp.setattr("app.routes.payments.http_get", lambda *a, **kw: FakeResponse(refunded))
        response = c.post(**refund_req)
        assert response.status_code == 200, response.text
        pay, status, refund_amount = records(order["id"])
        assert (pay, status) == ("refunded", "cancelled")
        assert Decimal(refund_amount) == Decimal(str(order["total"]))
        again = c.post(**refund_req)
        assert again.status_code == 200 and again.json().get("duplicate") is True
        with SessionLocal() as db:
            rows = db.scalars(select(models.FinancialLedgerEntry).where(
                models.FinancialLedgerEntry.order_id == order["id"],
                models.FinancialLedgerEntry.kind == "refund")).all()
            assert len(rows) == 2


def test_invalid_signature_rejected_before_psp_lookup(psp):
    with TestClient(app) as c:
        order, _ = create_order(c)
        _, req = notify(c, order, event="f207-bad-signature")
        def deny(request, data_id):
            raise HTTPException(401, "Firma invalida simulada")
        psp.setattr("app.routes.payments._verify_mp_signature", deny)
        res = c.post(**req)
        assert res.status_code == 401
        assert records(order["id"])[0] == "pending"


def test_provider_amount_mismatch_rejected_without_paid_status(psp):
    with TestClient(app) as c:
        order, _ = create_order(c)
        fraudulent, req = notify(c, order, event="f207-mismatched",
                                 paid_amount=Decimal(str(order["total"])) + Decimal("10"))
        psp.setattr("app.routes.payments.http_get", lambda *a, **kw: FakeResponse(fraudulent))
        res = c.post(**req)
        assert res.status_code == 409, res.text
        assert records(order["id"])[0] == "pending"


def test_provider_unavailable_requires_retry_without_marking_paid(psp):
    with TestClient(app) as c:
        order, _ = create_order(c)
        _, req = notify(c, order, event="f207-provider-502")
        psp.setattr("app.routes.payments.http_get", lambda *a, **kw: FakeResponse({}, 502))
        res = c.post(**req)
        assert res.status_code == 502
        assert records(order["id"])[0] == "pending"
