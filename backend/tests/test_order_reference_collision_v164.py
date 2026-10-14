"""P0 server-side replay semantics without Redis or external money providers."""
from fastapi.testclient import TestClient
from app.main import app


def _customer(client):
    r = client.post(
        "/api/v1/auth/login",
        headers={"X-TalaEats-Client": "customer-mobile"},
        json={"email": "cliente@talaeats.mx", "password": "Cliente123!"},
    )
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["access_token"]}


def _payload(ref):
    return {
        "restaurant_id": 1, "address": "Tala Centro QA",
        "order_type": "delivery", "payment_method": "cash",
        "distance_km": 1, "client_reference": ref,
        "items": [{"menu_item_id": 1, "quantity": 1}],
    }


def test_same_reference_same_body_returns_exact_order_without_second_charge():
    with TestClient(app) as c:
        headers = _customer(c)
        payload = _payload("qa-duplicate-identical-v164")
        first = c.post("/api/v1/orders", headers=headers, json=payload)
        second = c.post("/api/v1/orders", headers=headers, json=payload)
        assert first.status_code == 201, first.text
        assert second.status_code == 201, second.text
        assert first.json()["id"] == second.json()["id"]


def test_same_reference_different_items_rejected_even_without_redis_header():
    with TestClient(app) as c:
        headers = _customer(c)
        payload = _payload("qa-duplicate-conflict-v164")
        first = c.post("/api/v1/orders", headers=headers, json=payload)
        assert first.status_code == 201, first.text
        changed = {**payload, "items": [{"menu_item_id": 1, "quantity": 2}]}
        second = c.post("/api/v1/orders", headers=headers, json=changed)
        assert second.status_code == 409, second.text


def test_same_reference_changed_delivery_details_rejected_without_idem_header():
    with TestClient(app) as c:
        headers = _customer(c)
        payload = _payload("qa-duplicate-address-v164")
        first = c.post("/api/v1/orders", headers=headers, json=payload)
        assert first.status_code == 201, first.text
        changed = {**payload, "address": "Otra calle en Tala"}
        second = c.post("/api/v1/orders", headers=headers, json=changed)
        assert second.status_code == 409, second.text
