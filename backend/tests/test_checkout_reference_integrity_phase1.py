"""Phase 1: a client_reference cannot silently replay a different purchase.

No external money provider, production database, or Stripe LIVE is contacted.
The shared pytest fixture creates a fresh seeded SQLite DB for every test.
"""
import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import models
from app.db import SessionLocal
from app.main import app


def _login(client):
    response = client.post(
        "/api/v1/auth/login",
        headers={"X-TalaEats-Client": "customer-mobile"},
        json={"email": "cliente@talaeats.mx", "password": "Cliente123!"},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def _payload():
    return {
        "restaurant_id": 1,
        "address": "Calle de Pruebas 27, Tala",
        "notes": "sin cebolla",
        "order_type": "delivery",
        "payment_method": "cash",
        "distance_km": 1,
        "tip": "0",
        "client_reference": "phase1-" + uuid4().hex,
        "items": [{"menu_item_id": 1, "quantity": 1, "options": "asada"}],
    }


def _create(client, headers, payload):
    result = client.post("/api/v1/orders", headers=headers, json=payload)
    assert result.status_code == 201, result.text
    return result


def test_exact_replay_returns_same_order_and_one_stock_debit():
    with TestClient(app) as client:
        headers = _login(client)
        payload = _payload()
        with SessionLocal() as db:
            before = db.get(models.MenuItem, 1).stock
        first = _create(client, headers, payload)
        replay = _create(client, headers, payload)
        assert first.json()["id"] == replay.json()["id"]
        with SessionLocal() as db:
            after = db.get(models.MenuItem, 1).stock
            orders = db.scalars(select(models.Order).where(
                models.Order.client_reference == payload["client_reference"]
            )).all()
            events = db.scalars(select(models.OrderEvent).where(
                models.OrderEvent.order_id == first.json()["id"],
                models.OrderEvent.status == "received",
            )).all()
            assert len(orders) == 1
            assert len(events) == 1
            marker = json.loads(events[0].metadata_json)
            assert len(marker["checkout_intent_hmac"]) == 64
            assert "gift_card_code" not in marker
        assert after == before - 1


@pytest.mark.parametrize("field,changed", [
    ("address", "Un domicilio diferente"),
    ("notes", "con cebolla"),
    ("tip", "10"),
    ("payment_method", "mercadopago"),
    ("scheduled_for", "2026-10-18T12:00:00Z"),
    ("delivery_lat", 20.65001),
    ("gift_card_code", "REGALO100"),
    ("recipient_phone", "3330000000"),
])
def test_reusing_same_reference_with_changed_intent_is_409(field, changed):
    with TestClient(app) as client:
        headers = _login(client)
        payload = _payload()
        _create(client, headers, payload)
        second = client.post("/api/v1/orders", headers=headers, json={
            **payload, field: changed,
        })
        assert second.status_code == 409, second.text


@pytest.mark.parametrize("items", [
    [{"menu_item_id": 1, "quantity": 2, "options": "asada"}],
    [{"menu_item_id": 1, "quantity": 1, "options": "pastor"}],
    [{"menu_item_id": 2, "quantity": 1, "options": "asada"}],
])
def test_same_reference_changed_items_rejected(items):
    with TestClient(app) as client:
        headers = _login(client)
        payload = _payload()
        _create(client, headers, payload)
        response = client.post("/api/v1/orders", headers=headers, json={
            **payload, "items": items,
        })
        assert response.status_code == 409, response.text


def test_legacy_without_fingerprint_uses_safe_persisted_fields():
    with TestClient(app) as client:
        headers = _login(client)
        payload = _payload()
        first = _create(client, headers, payload)
        with SessionLocal() as db:
            event = db.scalar(select(models.OrderEvent).where(
                models.OrderEvent.order_id == first.json()["id"],
                models.OrderEvent.status == "received",
            ))
            event.metadata_json = '{"source": "checkout"}'
            db.commit()
        assert _create(client, headers, payload).json()["id"] == first.json()["id"]
        response = client.post("/api/v1/orders", headers=headers, json={
            **payload, "address": "Calle falsa 555",
        })
        assert response.status_code == 409


def _register_other_customer(client):
    response = client.post(
        "/api/v1/auth/register",
        json={
            "name": "Usuario de prueba aislado",
            "email": f"f207-other-{uuid4().hex}@example.com",
            "password": "OnlySyntheticCustomer123!",
        },
    )
    assert response.status_code == 201, response.text
    return {
        "Authorization": "Bearer " + response.json()["access_token"],
        "X-TalaEats-Client": "customer-mobile",
    }


def test_phase2_same_reference_and_http_key_isolated_between_customers():
    """A Redis header cannot cache/replay another customer's entire order.

    Two different signed-in users intentionally submit the *same* body,
    client_reference and Idempotency-Key. Each is allowed their own purchase.
    We never make Stripe/MP requests or touch a real customer or bank.
    """
    with TestClient(app) as client:
        first_user = _login(client)
        second_user = _register_other_customer(client)
        payload = _payload()
        key = "same-client-reference-" + uuid4().hex
        payload["client_reference"] = key
        headers_a = {**first_user, "Idempotency-Key": key}
        headers_b = {**second_user, "Idempotency-Key": key}
        with SessionLocal() as db:
            initial = db.get(models.MenuItem, 1).stock
        first = _create(client, headers_a, payload)
        second = _create(client, headers_b, payload)
        assert first.json()["id"] != second.json()["id"], "Cross-account order response leak"
        assert first.json()["user_id"] != second.json()["user_id"]
        assert first.json()["client_reference"] == second.json()["client_reference"] == key
        # Replaying each scoped key returns its own order only.
        assert _create(client, headers_a, payload).json()["id"] == first.json()["id"]
        assert _create(client, headers_b, payload).json()["id"] == second.json()["id"]
        mine_b = client.get("/api/v1/orders/mine", headers=second_user)
        assert mine_b.status_code == 200, mine_b.text
        ids_b = {order["id"] for order in mine_b.json()}
        assert second.json()["id"] in ids_b
        assert first.json()["id"] not in ids_b
        with SessionLocal() as db:
            matches = db.scalars(
                select(models.Order).where(models.Order.client_reference == key)
            ).all()
            assert len(matches) == 2
            assert len({row.user_id for row in matches}) == 2
            assert db.get(models.MenuItem, 1).stock == initial - 2


def test_phase2_retry_with_header_body_mismatch_fails_closed():
    """Persistent PostgreSQL identity still guards changed checkout body."""
    with TestClient(app) as client:
        auth = _login(client)
        payload = _payload()
        headers = {**auth, "Idempotency-Key": payload["client_reference"]}
        first = _create(client, headers, payload)
        for change in (
            {"address": "Different shipping address"},
            {"tip": "4.00"},
            {"items": [{"menu_item_id": 1, "quantity": 2, "options": "asada"}]},
        ):
            altered = {**payload, **change}
            response = client.post("/api/v1/orders", headers=headers, json=altered)
            assert response.status_code == 409, response.text
        still_first = _create(client, headers, payload)
        assert still_first.json()["id"] == first.json()["id"]
        with SessionLocal() as db:
            rows = db.scalars(select(models.Order).where(
                models.Order.user_id == first.json()["user_id"],
                models.Order.client_reference == payload["client_reference"],
            )).all()
            assert len(rows) == 1
