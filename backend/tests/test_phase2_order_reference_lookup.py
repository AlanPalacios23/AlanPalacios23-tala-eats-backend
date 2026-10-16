"""F2.07 read-only recovery of a customer's own order by client_reference.

Purely synthetic SQLite-seeded FastAPI tests; no payments or live connections.
"""
from uuid import uuid4
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import models
from app.db import SessionLocal
from app.main import app


def auth(client):
    res = client.post("/api/v1/auth/login", json={
        "email": "cliente@talaeats.mx", "password": "Cliente123!"
    })
    assert res.status_code == 200
    return {"Authorization": "Bearer " + res.json()["access_token"]}


def second_auth(client):
    res = client.post("/api/v1/auth/register", json={
        "name": "Otra persona QA", "email": "f207-qa-" + uuid4().hex + "@example.com",
        "password": "Synthetic123!"
    })
    assert res.status_code == 201, res.text
    return {"Authorization": "Bearer " + res.json()["access_token"]}


def create(client, headers, ref):
    resp = client.post("/api/v1/orders", headers=headers, json={
        "restaurant_id": 1, "address": "Calle Test 123, Tala",
        "payment_method": "cash", "order_type": "pickup",
        "client_reference": ref,
        "items": [{"menu_item_id": 1, "quantity": 1}],
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


def count_orders():
    with SessionLocal() as db:
        return db.scalar(select(func.count(models.Order.id)))


def test_lookup_after_lost_post_ack_is_read_only():
    with TestClient(app) as client:
        headers = auth(client)
        ref = "f207-recover-" + uuid4().hex
        prior = create(client, headers, ref)
        before = count_orders()
        response = client.get(f"/api/v1/orders/by-reference/{ref}", headers=headers)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["id"] == prior["id"]
        assert result["client_reference"] == ref
        assert result["user_id"] == prior["user_id"]
        assert response.headers.get("cache-control") == "private, no-store"
        assert count_orders() == before
        again = client.get(f"/api/v1/orders/by-reference/{ref}", headers=headers)
        assert again.status_code == 200 and again.json()["id"] == prior["id"]
        assert count_orders() == before


def test_other_user_reference_indistinguishable_from_unknown():
    with TestClient(app) as client:
        owner = auth(client)
        other = second_auth(client)
        ref = "f207-private-" + uuid4().hex
        create(client, owner, ref)
        for candidate in (ref, "f207-nonexistent-" + uuid4().hex):
            rsp = client.get(f"/api/v1/orders/by-reference/{candidate}", headers=other)
            assert rsp.status_code == 404, rsp.text
            assert rsp.json().get("detail") == "Pedido no encontrado"
        guest = client.get(f"/api/v1/orders/by-reference/{ref}", headers={
            "Authorization": "Bearer invalid-synthetic-token"
        })
        assert guest.status_code == 401
        assert count_orders() == 1


def test_same_reference_two_users_retrieves_only_their_own_order():
    with TestClient(app) as client:
        first = auth(client)
        second = second_auth(client)
        ref = "f207-own-" + uuid4().hex
        a = create(client, first, ref)
        b = create(client, second, ref)
        assert a["id"] != b["id"]
        for headers, expected in ((first, a), (second, b)):
            lookup = client.get(f"/api/v1/orders/by-reference/{ref}", headers=headers)
            assert lookup.status_code == 200
            assert lookup.json()["id"] == expected["id"]
            assert lookup.json()["user_id"] == expected["user_id"]
        assert count_orders() == 2


def test_malformed_reference_rejected_without_db_writes():
    with TestClient(app) as client:
        headers = auth(client)
        for ref in ("x" * 81, "wrong!reference", "a+b", "bad%20reference"):
            response = client.get(f"/api/v1/orders/by-reference/{ref}", headers=headers)
            assert response.status_code == 422, response.text
        assert count_orders() == 0
