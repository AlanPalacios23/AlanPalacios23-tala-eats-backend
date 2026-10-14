from fastapi.testclient import TestClient

from app.main import app


def login(client, email, password):
    response = client.post(
        "/api/v1/auth/login",
        headers={"X-TalaEats-Client": "mobile"},
        json={"email": email, "password": password},
    )
    assert response.status_code == 200, response.text
    return {
        "Authorization": f"Bearer {response.json()['access_token']}",
        "X-TalaEats-Client": "mobile",
    }


def test_delivery_pin_is_customer_secret_not_operational_data():
    with TestClient(app) as client:
        customer = login(client, "cliente@talaeats.mx", "Cliente123!")
        item = client.get("/api/v1/restaurants/1").json()["menu_items"][0]
        created = client.post(
            "/api/v1/orders",
            headers=customer,
            json={
                "restaurant_id": 1,
                "address": "Centro, Tala, Jalisco",
                "payment_method": "cash",
                "distance_km": 1.0,
                "client_reference": "hardening-pin-secret-1",
                "items": [{"menu_item_id": item["id"], "quantity": 1}],
            },
        )
        assert created.status_code == 201, created.text
        order = created.json()
        assert len(order["delivery_pin"]) == 4

        owner = login(client, "restaurante@talaeats.mx", "Restaurante123!")
        owner_orders = client.get("/api/v1/owner/orders", headers=owner)
        assert owner_orders.status_code == 200, owner_orders.text
        owner_copy = next(row for row in owner_orders.json() if row["id"] == order["id"])
        assert "delivery_pin" not in owner_copy

        admin = login(client, "admin@talaeats.mx", "Admin123!")
        admin_orders = client.get("/api/v1/admin/orders", headers=admin)
        assert admin_orders.status_code == 200, admin_orders.text
        admin_copy = next(row for row in admin_orders.json() if row["id"] == order["id"])
        assert "delivery_pin" not in admin_copy

        customer_detail = client.get(f"/api/v1/orders/{order['id']}", headers=customer)
        assert customer_detail.status_code == 200
        assert customer_detail.json()["delivery_pin"] == order["delivery_pin"]


def test_bearer_logout_revokes_mobile_device_session():
    with TestClient(app) as client:
        headers = login(client, "cliente@talaeats.mx", "Cliente123!")
        before = client.get("/api/v1/auth/me", headers=headers)
        assert before.status_code == 200
        logged_out = client.post("/api/v1/auth/logout", headers=headers)
        assert logged_out.status_code == 204
        after = client.get("/api/v1/auth/me", headers=headers)
        assert after.status_code == 401


def test_upload_rejects_spoofed_image_mime_type():
    with TestClient(app) as client:
        driver = login(client, "repartidor@talaeats.mx", "Repartidor123!")
        response = client.post(
            "/api/v1/uploads/delivery-proof",
            headers=driver,
            files={"file": ("proof.png", b"this-is-not-a-png", "image/png")},
        )
        assert response.status_code == 415
        assert "contenido real" in response.json()["detail"].lower()


def test_inventory_restore_is_exactly_once_for_menu_and_ingredients(monkeypatch):
    from decimal import Decimal
    from app import models
    from app.config import settings
    from app.db import SessionLocal

    class FakeResponse:
        status_code = 201
        ok = True
        def json(self):
            return {"id": "refund-hardening-1", "payment_id": "pay-hardening-1"}

    monkeypatch.setattr(settings, "mercado_pago_access_token", "APP_USR_TEST")
    monkeypatch.setattr("app.routes.payments.http_post", lambda *a, **k: FakeResponse())

    with SessionLocal() as db:
        ingredient = models.IngredientStock(
            restaurant_id=1,
            name="Ingrediente hardening",
            unit="kg",
            quantity=Decimal("10.000"),
            reorder_level=Decimal("1.000"),
            unit_cost=Decimal("20.00"),
        )
        db.add(ingredient)
        db.flush()
        db.add(models.MenuRecipe(menu_item_id=1, ingredient_id=ingredient.id, quantity_required=Decimal("1.500")))
        initial_item_stock = db.get(models.MenuItem, 1).stock
        ingredient_id = ingredient.id
        db.commit()

    with TestClient(app) as client:
        customer = login(client, "cliente@talaeats.mx", "Cliente123!")
        created = client.post(
            "/api/v1/orders",
            headers=customer,
            json={
                "restaurant_id": 1,
                "address": "Centro, Tala, Jalisco",
                "payment_method": "mercadopago",
                "distance_km": 1.0,
                "client_reference": "hardening-refund-stock-once",
                "items": [{"menu_item_id": 1, "quantity": 2}],
            },
        )
        assert created.status_code == 201, created.text
        order_id = created.json()["id"]

        with SessionLocal() as db:
            order = db.get(models.Order, order_id)
            order.payment_status = "paid"
            order.payment_provider_id = "pay-hardening-1"
            db.commit()
            assert db.get(models.MenuItem, 1).stock == initial_item_stock - 2
            assert Decimal(db.get(models.IngredientStock, ingredient_id).quantity) == Decimal("7.000")
            # A later recipe edit must not change what this already-created order restores.
            recipe = db.query(models.MenuRecipe).filter(
                models.MenuRecipe.menu_item_id == 1,
                models.MenuRecipe.ingredient_id == ingredient_id,
            ).one()
            recipe.quantity_required = Decimal("9.000")
            db.commit()

        admin = login(client, "admin@talaeats.mx", "Admin123!")
        first = client.post(f"/api/v1/payments/mercadopago/orders/{order_id}/refund", headers=admin)
        assert first.status_code == 200, first.text
        second = client.post(f"/api/v1/payments/mercadopago/orders/{order_id}/refund", headers=admin)
        assert second.status_code == 200, second.text
        assert second.json()["already_refunded"] is True

        with SessionLocal() as db:
            order = db.get(models.Order, order_id)
            assert db.get(models.MenuItem, 1).stock == initial_item_stock
            assert Decimal(db.get(models.IngredientStock, ingredient_id).quantity) == Decimal("10.000")
            assert order.inventory_restored_at is not None
            assert Decimal(order.refunded_amount) == Decimal(order.total)


def test_system_status_accepts_tuple_redis_health(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "redis_url", "redis://example.invalid/0")
    monkeypatch.setattr("app.routes.v9.redis_ping", lambda: (True, "2026-10-08T00:00:00+00:00"))
    with TestClient(app) as client:
        admin = login(client, "admin@talaeats.mx", "Admin123!")
        response = client.get("/api/v1/v9/admin/system-status", headers=admin)
        assert response.status_code == 200, response.text
        assert response.json()["checks"]["redis"] == "ok"
        assert response.json()["checks"]["worker"] == "ok"
