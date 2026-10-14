"""Regresión: el catálogo con fotos debe responder desde effective-menu.

El bug original no se veía en los tests previos porque el endpoint V9 no se
invocaba con productos; en v1.6.1 faltaba importar _effective_item.
"""

from decimal import Decimal

from fastapi.testclient import TestClient

from app import models
from app.db import SessionLocal
from app.main import app


def test_effective_menu_publica_foto_precio_efectivo_y_stock():
    with SessionLocal() as db:
        item = db.query(models.MenuItem).filter_by(restaurant_id=1).first()
        assert item is not None
        item.image_url = "https://talaeats.example/api/v1/uploads/catalog/prueba.webp"
        item.price_schedule_json = ('{"windows":[{"days":[0,1,2,3,4,5,6],'
                                    '"start":"00:00","end":"23:59","multiplier":"0.5"}]}')
        item.availability_schedule_json = "{}"
        item.is_available = True
        item.stock = 2
        db.commit()
        item_id = item.id
        expected_price = str((Decimal(item.price) * Decimal("0.5")).quantize(Decimal("0.01")))

    with TestClient(app) as client:
        response = client.get("/api/v1/v9/restaurants/1/effective-menu")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["restaurant_id"] == 1
    row = next(r for r in payload["items"] if r["id"] == item_id)
    assert row["image_url"] == "https://talaeats.example/api/v1/uploads/catalog/prueba.webp"
    assert row["effective_price"] == expected_price
    assert row["available_now"] is True
    assert row["stock"] == 2


def test_effective_menu_stock_agotado_no_disponible():
    with SessionLocal() as db:
        item = db.query(models.MenuItem).filter_by(restaurant_id=1).first()
        assert item is not None
        item.stock = 0
        db.commit()
        item_id = item.id

    with TestClient(app) as client:
        response = client.get("/api/v1/v9/restaurants/1/effective-menu")
    assert response.status_code == 200, response.text
    row = next(r for r in response.json()["items"] if r["id"] == item_id)
    assert row["available_now"] is False


def test_effective_menu_restaurante_inexistente_404():
    with TestClient(app) as client:
        response = client.get("/api/v1/v9/restaurants/999999/effective-menu")
    assert response.status_code == 404
