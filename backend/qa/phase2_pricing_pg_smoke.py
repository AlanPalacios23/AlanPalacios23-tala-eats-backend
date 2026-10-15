"""F2.11 PostgreSQL16 and Redis8 checkout/ledger contract on DISPOSABLE QA ONLY.

Runs after Alembic, seed and Phase 1 multi-worker smoke in GitHub-hosted CI.
Never calls Stripe, MP, Connect or payout APIs and never reads live secrets.
"""
import os
from decimal import Decimal
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select

from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app

EXPECTED_DB = "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa"
EXPECTED_REDIS = "redis://127.0.0.1:6379/0"


def money(x):
    return Decimal(str(x))


def require_disposable() -> None:
    assert os.environ.get("DATABASE_URL") == EXPECTED_DB == settings.database_url
    assert os.environ.get("REDIS_URL") == EXPECTED_REDIS == settings.redis_url
    assert settings.environment == "development"
    assert not settings.seed_demo_data
    assert not settings.stripe_enabled and not settings.stripe_secret_key
    assert not settings.stripe_connect_enabled
    assert not settings.mercado_pago_access_token
    assert not settings.withdrawals_execution_enabled
    assert not settings.withdrawals_live_enabled


def verify_order(order, *, delivery, driver, tip, gross):
    assert money(order["subtotal"]) == Decimal("425.00"), order
    assert money(order["platform_commission"]) == Decimal("63.75"), order
    assert money(order["service_fee"]) == Decimal("25.00"), order
    assert money(order["delivery_fee"]) == Decimal(delivery), order
    assert money(order["driver_earning"]) == Decimal(driver), order
    assert money(order["total"]) == Decimal(gross), order
    assert money(order["tip"]) == Decimal(tip), order
    assert order["payment_status"] == "pending", order
    with SessionLocal() as db:
        ledger = db.scalars(select(models.FinancialLedgerEntry).where(
            models.FinancialLedgerEntry.order_id == order["id"]
        )).all()
    by_account = {row.account: money(row.amount) for row in ledger}
    assert len(by_account) == len(ledger), "Duplicate financial ledger account"
    assert by_account["gmv"] == money(order["total"])
    assert by_account["restaurant_payable"] == money(order["restaurant_payout"])
    assert by_account["platform_revenue"] == money(order["platform_revenue"])
    expected_driver = money(driver) + (money(tip) if order["order_type"] == "delivery" else 0)
    assert by_account.get("driver_payable", Decimal("0")) == expected_driver
    assert (
        by_account["restaurant_payable"]
        + by_account.get("driver_payable", Decimal("0"))
        + by_account["platform_revenue"]
    ) == money(gross)


def main():
    require_disposable()
    # Explicit opt-in: policy is OFF by default and must not be assumed LIVE.
    settings.commercial_pricing_v152_enabled = True
    settings.commercial_pricing_v162_enabled = True
    settings.merchant_managed_delivery = False
    with SessionLocal() as db:
        customer = db.scalar(select(models.User).where(
            models.User.email == "cliente@talaeats.mx"))
        restaurant = db.scalar(select(models.Restaurant).where(
            models.Restaurant.name == "Tacos El Centro"))
        assert customer is not None and restaurant is not None
        loyalty = db.scalar(select(models.LoyaltyAccount).where(
            models.LoyaltyAccount.user_id == customer.id))
        assert loyalty is not None
        loyalty.plus_member = False
        restaurant.delivery_radius_km = 20
        restaurant_id = restaurant.id
        menu_item = db.scalar(select(models.MenuItem).where(
            models.MenuItem.restaurant_id == restaurant_id).order_by(models.MenuItem.id))
        assert menu_item is not None
        menu_id = menu_item.id
        db.commit()

    cases = [
        ("cash", "delivery", 2.5, "37.50", "34.00", "12.00", "499.50"),
        ("mercadopago", "delivery", 8, "65.00", "56.00", "12.00", "527.00"),
        ("cash", "pickup", 0, "0.00", "0.00", "10.00", "460.00"),
    ]
    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={
            "email": "cliente@talaeats.mx", "password": "Cliente123!"
        }, headers={"X-TalaEats-Client": "customer-mobile"})
        assert login.status_code == 200, login.text[:150]
        headers = {"Authorization": "Bearer " + login.json()["access_token"]}
        methods = client.get("/api/v1/orders/payment-methods")
        assert methods.status_code == 200
        assert methods.json()["commercial_pricing_version"] == "1.6.2"
        assert methods.json()["service_fee_cap"] == "25.00"

        for method, order_type, distance, fee, driver, tip, total in cases:
            payload = {
                "restaurant_id": restaurant_id,
                "address": "Solo QA efimera, Tala",
                "order_type": order_type,
                "payment_method": method,
                "distance_km": distance,
                "tip": tip,
                "client_reference": "F211-PG-" + uuid4().hex,
                "items": [{"menu_item_id": menu_id, "quantity": 5}],
            }
            response = client.post("/api/v1/orders", json=payload, headers=headers)
            assert response.status_code == 201, (method, response.status_code, response.text[:450])
            created = response.json()
            verify_order(created, delivery=fee, driver=driver, tip=tip, gross=total)
            if order_type == "pickup":
                assert money(created["restaurant_payout"]) == Decimal("371.25")
            if method == "cash":
                assert money(created["payment_processing_fee"]) == 0
            else:
                assert money(created["payment_processing_fee"]) > 0
            # No duplicate ledger or stock changes after identical replay.
            retry = client.post("/api/v1/orders", json=payload, headers=headers)
            assert retry.status_code == 201 and retry.json()["id"] == created["id"]

    print("F211_PRICING_POSTGRES_LEDGER_PASS: policy opt-in, 15pct, 7pct cap25, "
          "delivery35+5/km, driver32+4/km, tips100pct, 3 checkout types, "
          "replay once, no PSP network, no money LIVE")


if __name__ == "__main__":
    main()
