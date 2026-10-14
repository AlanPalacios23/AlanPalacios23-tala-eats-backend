"""Four-role HTTP contract on disposable PostgreSQL/Redis, no real money.

This checks API interactions corresponding to Customer, Restaurant, Driver, and
ADMIN, NOT physical Flutter apps or Stripe E2E. Fail closed on any non-QA URL.
"""
import os
import uuid
from sqlalchemy import select, func
from fastapi.testclient import TestClient
from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app

QA_DATABASE = "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa"

def guard():
    assert os.getenv("DATABASE_URL") == settings.database_url == QA_DATABASE
    assert settings.environment == "development"
    assert settings.redis_url == "redis://127.0.0.1:6379/0"
    assert not settings.stripe_enabled and not settings.stripe_secret_key
    assert not settings.withdrawals_execution_enabled and not settings.withdrawals_live_enabled
    assert not settings.mercado_pago_access_token

def login(c, email, password):
    r = c.post("/api/v1/auth/login", json={"email": email, "password": password},
               headers={"X-TalaEats-Client": "customer-mobile"})
    assert r.status_code == 200, (email, r.status_code, r.text[:180])
    return {"Authorization": "Bearer " + r.json()["access_token"]}

def request(c, method, path, h, expected, **kwargs):
    resp = c.request(method, path, headers=h, **kwargs)
    assert resp.status_code == expected, (method, path, expected, resp.status_code, resp.text[:450])
    return resp

def main():
    guard()
    with SessionLocal() as db:
        r = db.scalar(select(models.Restaurant).where(models.Restaurant.name == "Tacos El Centro"))
        assert r and r.owner_id
        rest_id = r.id
        item = db.scalar(select(models.MenuItem).where(models.MenuItem.restaurant_id == rest_id).order_by(models.MenuItem.id))
        assert item and item.stock >= 1
        item_id = item.id

    with TestClient(app) as c:
        customer = login(c, "cliente@talaeats.mx", "Cliente123!")
        merchant = login(c, "restaurante@talaeats.mx", "Restaurante123!")
        driver = login(c, "repartidor@talaeats.mx", "Repartidor123!")
        admin = login(c, "admin@talaeats.mx", "Admin123!")

        # Prevent cross-role reads and financial privilege escalation.
        for unauthorized in (customer, merchant, driver):
            request(c, "GET", "/api/v1/admin/stats", unauthorized, 403)
        for unauthorized in (customer, driver):
            request(c, "GET", "/api/v1/owner/orders", unauthorized, 403)
        for unauthorized in (customer, merchant):
            request(c, "GET", "/api/v1/driver/dashboard", unauthorized, 403)
        stats_before = request(c, "GET", "/api/v1/admin/stats", admin, 200).json()["orders"]

        ref = "qa-four-roles-" + uuid.uuid4().hex
        payload = {
            "restaurant_id": rest_id, "address": "Tala QA: calle sintetica",
            "order_type": "delivery", "distance_km": 0.5,
            "payment_method": "cash", "client_reference": ref,
            "items": [{"menu_item_id": item_id, "quantity": 1}],
        }
        order = request(c, "POST", "/api/v1/orders", customer, 201, json=payload).json()
        oid = order["id"]
        assert order["status"] == "received"

        merchant_orders = request(c, "GET", "/api/v1/owner/orders", merchant, 200).json()
        assert any(o["id"] == oid for o in merchant_orders)
        request(c, "PATCH", f"/api/v1/owner/orders/{oid}/status", driver, 403,
                json={"status": "confirmed"})
        for status in ("confirmed", "preparing", "ready"):
            state = request(c, "PATCH", f"/api/v1/owner/orders/{oid}/status", merchant, 200,
                            json={"status": status}).json()
            assert state["status"] == status

        # Owner may assign the driver automatically when marking ready.
        with SessionLocal() as db:
            record = db.get(models.Order, oid)
            assigned_to = record.driver_id
            target_driver = db.scalar(select(models.User).where(models.User.email == "repartidor@talaeats.mx"))
            if assigned_to is not None:
                assert assigned_to == target_driver.id
        if assigned_to is None:
            accepted = request(c, "POST", f"/api/v1/driver/orders/{oid}/accept", driver, 200).json()
            assert accepted["status"] == "assigned"

        mine = request(c, "GET", "/api/v1/driver/mine", driver, 200).json()
        assert any(o["id"] == oid for o in mine)
        for status in ("picked_up", "on_the_way"):
            got = request(c, "PATCH", f"/api/v1/driver/orders/{oid}/status", driver, 200,
                          json={"status": status}).json()
            assert got["status"] == status

        detail = request(c, "GET", f"/api/v1/orders/{oid}", customer, 200).json()
        pin = detail["delivery_pin"]
        request(c, "POST", f"/api/v1/driver/orders/{oid}/complete", driver, 400,
                json={"pin": "0000" if pin != "0000" else "9999"})
        result = request(c, "POST", f"/api/v1/driver/orders/{oid}/complete", driver, 200,
                         json={"pin": pin}).json()
        assert result["status"] == "delivered" and result["payment_status"] == "paid"
        stats_after = request(c, "GET", "/api/v1/admin/stats", admin, 200).json()["orders"]
        assert stats_after == stats_before + 1
        admin_orders = request(c, "GET", "/api/v1/admin/orders", admin, 200).json()
        assert any(o["id"] == oid and o["status"] == "delivered" for o in admin_orders)

    with SessionLocal() as db:
        record = db.get(models.Order, oid)
        assert record and record.status == "delivered"
        events = [e.status for e in db.scalars(select(models.OrderEvent).where(
            models.OrderEvent.order_id == oid).order_by(models.OrderEvent.id))]
        assert events == ["received", "confirmed", "preparing", "ready",
                          "assigned", "picked_up", "on_the_way", "delivered"], events
        assert db.scalar(select(func.count(models.DeliveryProof.id)).where(
            models.DeliveryProof.order_id == oid)) == 1
    print("FOUR_ROLE_API_E2E_PASS: customer merchant driver admin, access, order, delivery, finance-free")

if __name__ == "__main__":
    main()
