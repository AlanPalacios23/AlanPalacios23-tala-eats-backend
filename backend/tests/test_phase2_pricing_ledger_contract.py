"""F2.11: commercial pricing v1.6.2 end-to-end through real checkout/ledger.

Synthetic SQLite only (autouse conftest); provider credentials are placeholders,
the payment-intent and provider network routes are never invoked.
"""
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app


def D(value) -> Decimal:
    return Decimal(str(value))


@pytest.fixture(autouse=True)
def activate_commercial_policy(monkeypatch):
    monkeypatch.setattr(settings, "commercial_pricing_v152_enabled", True)
    monkeypatch.setattr(settings, "commercial_pricing_v162_enabled", True)
    monkeypatch.setattr(settings, "merchant_managed_delivery", False)
    monkeypatch.setattr(settings, "require_online_payments", False)
    # Synthetic credentials only let checkout record a pending Stripe order.
    # No PaymentIntent, webhook, network call, bank or LIVE flag is enabled.
    monkeypatch.setattr(settings, "stripe_enabled", True)
    monkeypatch.setattr(settings, "stripe_secret_key", "QA_PLACEHOLDER_NOT_PROVIDER_CREDENTIAL")
    monkeypatch.setattr(settings, "stripe_webhook_secret", "QA_PLACEHOLDER_NO_SIGNATURE")
    monkeypatch.setattr(settings, "withdrawals_execution_enabled", False)
    monkeypatch.setattr(settings, "withdrawals_live_enabled", False)
    with SessionLocal() as db:
        customer = db.scalar(select(models.User).where(
            models.User.email == "cliente@talaeats.mx"))
        assert customer is not None
        account = db.scalar(select(models.LoyaltyAccount).where(
            models.LoyaltyAccount.user_id == customer.id))
        assert account is not None
        account.plus_member = False
        restaurant = db.get(models.Restaurant, 1)
        assert restaurant is not None
        restaurant.delivery_radius_km = 20
        db.commit()


def authenticate(client):
    resp = client.post(
        "/api/v1/auth/login",
        headers={"X-TalaEats-Client": "customer-mobile"},
        json={"email": "cliente@talaeats.mx", "password": "Cliente123!"},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": "Bearer " + resp.json()["access_token"]}


def assert_ledger_matches_order(order: dict) -> None:
    with SessionLocal() as db:
        items = db.scalars(select(models.FinancialLedgerEntry).where(
            models.FinancialLedgerEntry.order_id == order["id"]
        )).all()
        entries = {x.account: x for x in items}
        assert len(entries) == len(items), "Duplicate ledger account rows"
        assert len({x.idempotency_key for x in items}) == len(items)
        assert D(entries["gmv"].amount) == D(order["total"])
        assert D(entries["restaurant_payable"].amount) == D(order["restaurant_payout"])
        assert D(entries["platform_revenue"].amount) == D(order["platform_revenue"])
        tip = D(order["tip"])
        is_delivery = order["order_type"] == "delivery"
        expected_driver = D(order["driver_earning"]) + (tip if is_delivery else D("0"))
        if expected_driver:
            assert D(entries["driver_payable"].amount) == expected_driver
        else:
            assert "driver_payable" not in entries
        assert (
            D(entries["restaurant_payable"].amount)
            + (D(entries["driver_payable"].amount) if expected_driver else D("0"))
            + D(entries["platform_revenue"].amount)
        ) == D(order["total"])
        assert D(entries["contribution_margin"].amount) == D(order["contribution_margin"])
        if order["payment_method"] == "cash":
            assert "payment_processing" not in entries
        else:
            assert D(entries["payment_processing"].amount) > 0


@pytest.mark.parametrize("method,distance,delivery,driver", [
    ("cash", 0, "35.00", "32.00"),
    ("cash", 2, "35.00", "32.00"),
    ("cash", 2.5, "37.50", "34.00"),
    ("cash", 3, "40.00", "36.00"),
    ("cash", 8, "65.00", "56.00"),
    ("mercadopago", 2.5, "37.50", "34.00"),
    ("stripe", 2.5, "37.50", "34.00"),
])
def test_delivery_checkout_commercial_policy_and_immutable_ledger(
    method, distance, delivery, driver,
):
    with TestClient(app) as client:
        auth = authenticate(client)
        reference = "f211-" + uuid4().hex
        payload = {
            "restaurant_id": 1,
            "address": "QA Fase 2, Tala",
            "order_type": "delivery",
            "payment_method": method,
            "distance_km": distance,
            "tip": "12.00",
            "client_reference": reference,
            "items": [{"menu_item_id": 1, "quantity": 5}],
        }
        response = client.post("/api/v1/orders", json=payload, headers=auth)
        assert response.status_code == 201, response.text
        order = response.json()

        assert D(order["subtotal"]) == D("425.00")
        assert D(order["platform_commission"]) == D("63.75")  # 15% food.
        assert D(order["service_fee"]) == D("25.00")  # 7%, cap 25.
        assert D(order["delivery_fee"]) == D(delivery)
        assert D(order["driver_earning"]) == D(driver)
        assert D(order["restaurant_payout"]) == D("361.25")
        assert D(order["tip"]) == D("12.00")
        assert D(order["total"]) == D("425") + D(delivery) + D("25") + D("12")
        assert D(order["platform_revenue"]) == (
            D("63.75") + D("25") + D(delivery) - D(driver)
        )
        assert D(order["contribution_margin"]) == (
            D(order["platform_revenue"]) - D(order["payment_processing_fee"])
        )
        assert order["payment_status"] == "pending"  # No provider call.
        assert_ledger_matches_order(order)

        # Exactly the same economic snapshot must survive a retry, not repost.
        replay = client.post("/api/v1/orders", json=payload, headers=auth)
        assert replay.status_code == 201, replay.text
        assert replay.json()["id"] == order["id"]
        assert replay.json()["total"] == order["total"]
        assert_ledger_matches_order(order)


@pytest.mark.parametrize("method", ["cash", "mercadopago", "stripe"])
def test_pickup_tip_entirely_merchant_no_driver_or_delivery(method):
    with TestClient(app) as client:
        auth = authenticate(client)
        response = client.post("/api/v1/orders", headers=auth, json={
            "restaurant_id": 1,
            "address": "QA pickup",
            "order_type": "pickup",
            "payment_method": method,
            "tip": "10.00",
            "client_reference": "f211-pickup-" + uuid4().hex,
            "items": [{"menu_item_id": 1, "quantity": 5}],
        })
        assert response.status_code == 201, response.text
        order = response.json()
        assert D(order["platform_commission"]) == D("63.75")
        assert D(order["service_fee"]) == D("25.00")
        assert D(order["delivery_fee"]) == D("0")
        assert D(order["driver_earning"]) == D("0")
        assert D(order["restaurant_payout"]) == D("371.25")  # Includes full tip.
        assert D(order["platform_revenue"]) == D("88.75")
        assert D(order["total"]) == D("460.00")
        assert_ledger_matches_order(order)


@pytest.mark.parametrize("method", ["cash", "mercadopago", "stripe"])
def test_discount_changes_fee_base_but_does_not_tax_tips(method):
    with TestClient(app) as client:
        auth = authenticate(client)
        response = client.post("/api/v1/orders", headers=auth, json={
            "restaurant_id": 1,
            "address": "QA discounted pickup",
            "order_type": "pickup",
            "payment_method": method,
            "tip": "10.00",
            "coupon_code": "TALA20",
            "client_reference": "f211-discount-" + uuid4().hex,
            "items": [{"menu_item_id": 1, "quantity": 5}],
        })
        assert response.status_code == 201, response.text
        order = response.json()
        assert D(order["subtotal"]) == D("425.00")
        assert D(order["discount"]) == D("85.00")
        assert D(order["service_fee"]) == D("23.80")  # 7% of net 340.
        assert D(order["platform_commission"]) == D("51.00")
        assert D(order["restaurant_payout"]) == D("299.00")  # Net food less commission + tip.
        assert D(order["total"]) == D("373.80")
        assert_ledger_matches_order(order)


def test_pricing_v162_disabled_by_default_must_never_be_silent(monkeypatch):
    monkeypatch.setattr(settings, "commercial_pricing_v162_enabled", False)
    with TestClient(app) as client:
        response = client.get("/api/v1/orders/payment-methods")
        assert response.status_code == 200, response.text
        assert response.json()["commercial_pricing_version"] != "1.6.2"
    # The release gate, not this test, must verify explicit activation in Kali.
