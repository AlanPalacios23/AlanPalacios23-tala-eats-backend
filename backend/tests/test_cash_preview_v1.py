"""Cash preview tests. No Stripe calls, no transfers, no reconciliation writes."""
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.cash_preview import project_cash_order, summarize_cash_projection
from app.main import app

D = Decimal


def order(**overrides):
    values = {
        "id": 101,
        "status": "delivered",
        "payment_method": "cash",
        "payment_status": "paid",
        "order_type": "delivery",
        "driver_id": 4,
        "restaurant_id": 1,
        "total": D("249.00"),
        "cash_collected": D("249.00"),
        "restaurant_payout": D("170.00"),
        "driver_earning": D("32.00"),
        "tip": D("0.00"),
        "platform_revenue": D("47.00"),
        "refunded_amount": D("0.00"),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_delivery_example_pilot_200_pesos_food():
    row = project_cash_order(order())
    assert row["status"] == "projected_unverified"
    assert row["collector_type"] == "driver"
    assert row["collector_id"] == 4
    assert row["cash_recorded"] == "249.00"
    assert row["collector_entitlement"] == "32.00"
    # $217 includes restaurant $170; platform revenue is only $47.
    assert row["remittance_projection"] == "217.00"
    assert row["merchant_receivable"] == "170.00"
    assert row["platform_revenue_estimate"] == "47.00"
    assert row["bank_verified"] is False
    assert row["actionable"] is False


def test_pickup_merchant_collects_and_remits_44():
    row = project_cash_order(order(
        order_type="pickup", driver_id=None, total=D("214.00"),
        cash_collected=D("214.00"), driver_earning=D("0"),
        platform_revenue=D("44.00")
    ))
    assert row["status"] == "projected_unverified"
    assert row["collector_type"] == "restaurant"
    assert row["collector_id"] == 1
    assert row["collector_entitlement"] == "170.00"
    assert row["remittance_projection"] == "44.00"
    assert row["merchant_receivable"] == "0.00"


def test_entire_tip_is_retained_by_driver():
    row = project_cash_order(order(
        total=D("269.00"), cash_collected=D("269.00"), tip=D("20.00")
    ))
    assert row["collector_entitlement"] == "52.00"
    assert row["remittance_projection"] == "217.00"
    assert row["platform_revenue_estimate"] == "47.00"


@pytest.mark.parametrize("changes,reason", [
    ({"payment_method": "stripe"}, "not_cash"),
    ({"status": "cancelled"}, "not_delivered"),
    ({"payment_status": "pending"}, "not_recorded_paid"),
    ({"refunded_amount": D("1")}, "refund_requires_reconciliation"),
    ({"driver_id": None}, "no_driver_to_confirm_collection"),
    ({"cash_collected": D("0")}, "cash_receipt_missing_or_inconsistent"),
    ({"cash_collected": D("248.99")}, "cash_receipt_missing_or_inconsistent"),
    ({"platform_revenue": D("46")}, "economics_do_not_balance"),
    ({"restaurant_payout": D("NaN")}, "invalid_amount"),
    ({"total": D("-1")}, "invalid_amount"),
    ({"order_type": "merchant_delivery"}, "unsupported_order_type"),
])
def test_fails_closed_without_booking_money(changes, reason):
    row = project_cash_order(order(**changes))
    assert row["status"] == "requires_review"
    assert row["reason"] == reason
    assert row["remittance_projection"] == "0.00"
    assert row["actionable"] is False


def test_legacy_cash_settlement_blocks_cash_projection():
    driver = project_cash_order(order())
    result = summarize_cash_projection(
        [driver], legacy_hold_collectors={("driver", 4)}
    )
    assert result["historical_hold_records_on_page"] == 1
    assert result["projected_unverified_remittance_on_page"] == "0.00"
    assert result["orders"][0]["status"] == "historical_hold"
    assert result["may_collect"] is False


def test_preview_only_sums_records_on_current_page_not_balance():
    rows = [
        project_cash_order(order(id=101)),
        project_cash_order(order(id=102, status="cancelled")),
        project_cash_order(order(id=103, total=D("269"), cash_collected=D("269"), tip=D("20"))),
    ]
    result = summarize_cash_projection(rows, has_more=True)
    assert result["projected_records_on_page"] == 2
    assert result["projected_unverified_remittance_on_page"] == "434.00"
    assert result["has_more"] is True
    assert result["complete"] is False
    assert result["bank_verified"] is False
    assert result["may_collect"] is False


def _auth(client, email, password):
    response = client.post(
        "/api/v1/auth/login", json={"email": email, "password": password}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def test_cash_preview_endpoints_are_authenticated_and_read_only():
    with TestClient(app) as client:
        base = "/api/v1/cash-preview"
        for path in ("/admin", "/driver/me", "/restaurant/me"):
            assert client.get(base + path).status_code == 401
            assert client.post(base + path).status_code in (401, 405)

        customer = _auth(client, "cliente@talaeats.mx", "Cliente123!")
        for path in ("/admin", "/driver/me", "/restaurant/me"):
            assert client.get(base + path, headers=customer).status_code == 403

        driver = _auth(client, "repartidor@talaeats.mx", "Repartidor123!")
        ok = client.get(base + "/driver/me", headers=driver)
        assert ok.status_code == 200, ok.text
        assert ok.json()["may_collect"] is False
        assert ok.json()["bank_verified"] is False
        assert client.get(base + "/admin", headers=driver).status_code == 403
        assert client.get(base + "/restaurant/me", headers=driver).status_code == 403

        owner = _auth(client, "restaurante@talaeats.mx", "Restaurante123!")
        ok = client.get(base + "/restaurant/me", headers=owner)
        assert ok.status_code == 200, ok.text
        assert ok.json()["preview_only"] is True
        assert client.get(base + "/driver/me", headers=owner).status_code == 403

        admin = _auth(client, "admin@talaeats.mx", "Admin123!")
        ok = client.get(base + "/admin", headers=admin)
        assert ok.status_code == 200, ok.text
        assert ok.json()["may_collect"] is False
        assert client.get(base + "/admin?days=365", headers=admin).status_code == 422
        assert client.get(base + "/admin?limit=1000", headers=admin).status_code == 422
