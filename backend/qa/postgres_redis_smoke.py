"""POSTGRESQL/REDIS QA ONLY. Never connect to Kali, money providers or real DBs."""
import os
import uuid

from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.config import settings
from app.db import engine
from app.main import app

def main():
    expected = "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa"
    assert os.environ.get("DATABASE_URL") == expected, "Refusing non-ephemeral database"
    assert settings.database_url == expected and settings.environment == "development"
    assert settings.redis_url == "redis://127.0.0.1:6379/0", "Refusing non-ephemeral Redis"
    assert not settings.stripe_enabled and not settings.withdrawals_execution_enabled
    assert not settings.withdrawals_live_enabled and not settings.stripe_secret_key
    assert not settings.mercado_pago_access_token
    assert not settings.seed_demo_data, "No demo seeding in migration QA"

    alembic = ScriptDirectory.from_config(Config("alembic.ini"))
    heads = alembic.get_heads()
    assert len(heads) == 1, heads
    with engine.connect() as connection:
        db_version = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        assert db_version == heads[0], (db_version, heads)
        assert connection.execute(text("SELECT 1")).scalar_one() == 1

    db = inspect(engine)
    expected_tables = {
        "users", "restaurants", "menu_items", "orders", "order_items",
        "financial_ledger_entries", "audit_events", "withdrawal_requests", "alembic_version"
    }
    assert expected_tables.issubset(set(db.get_table_names())), expected_tables-set(db.get_table_names())
    assert {"client_reference", "user_id", "restaurant_id"}.issubset(
        {c["name"] for c in db.get_columns("orders")}
    )
    unique = db.get_unique_constraints("orders")
    assert any({"user_id", "client_reference"} == set(v["column_names"]) for v in unique), unique
    assert "address" in {c["name"] for c in db.get_columns("restaurants")}

    # PostgreSQL-specific immutable finance/audit triggers (SQLite cannot verify).
    with engine.connect() as connection:
        triggers = set(connection.execute(text("""
            SELECT tgname FROM pg_trigger
            WHERE NOT tgisinternal AND tgrelid IN (
               'financial_ledger_entries'::regclass, 'audit_events'::regclass
            )
        """)).scalars())
    assert {"trg_financial_ledger_immutable", "trg_audit_events_immutable"}.issubset(triggers), triggers

    import redis
    client = redis.Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=3)
    assert client.ping()
    key = "talaeats:ci:isolated:" + uuid.uuid4().hex
    try:
        assert client.set(key, "first", nx=True, ex=10)
        assert client.set(key, "second", nx=True, ex=10) is None
        assert client.get(key) == "first"
        assert client.ttl(key) > 0
    finally:
        client.delete(key)
        client.close()

    # Read-only endpoints against the fresh database, no orders or external calls.
    # One lifespan/context owns the event loop of the shared async Redis
    # client. A separate TestClient for each request triggers loop-closed errors.
    with TestClient(app, raise_server_exceptions=True) as client_http:
        for url in ("/api/v1/orders/mine", "/api/v1/owner/orders", "/api/v1/driver/dashboard"):
            resp = client_http.get(url)
            assert resp.status_code in (401, 403), (url, resp.status_code, resp.text[:300])
        ready = client_http.get("/api/v1/ready")
        assert ready.status_code == 200 and ready.json()["ready"] is True, ready.text[:400]
        assert ready.json()["database"] is True and ready.json()["redis"] is True

        # Synthetic QA-only customer and order. External payment flags are off.
        # Tests the real PostgreSQL uniqueness constraint + Redis response replay.
        from app.db import SessionLocal
        from app.seed import seed_database
        from app import models
        from sqlalchemy import select, func
        with SessionLocal() as db:
            seed_database(db)
            restaurant = db.scalar(select(models.Restaurant).where(models.Restaurant.name == "Tacos El Centro"))
            assert restaurant is not None, "Synthetic QA seed failed"
            item = db.scalar(select(models.MenuItem).where(models.MenuItem.restaurant_id == restaurant.id).order_by(models.MenuItem.id))
            assert item is not None
            restaurant_id, item_id, stock_before = restaurant.id, item.id, item.stock

        login = client_http.post("/api/v1/auth/login", headers={"X-TalaEats-Client": "customer-mobile"},
            json={"email": "cliente@talaeats.mx", "password": "Cliente123!"})
        assert login.status_code == 200, ("QA login", login.status_code, login.text[:200])
        access_token = login.json().get("access_token", "")
        assert access_token and access_token != "cookie"
        reference = "qa-" + uuid.uuid4().hex
        header = {"Authorization": "Bearer " + access_token, "Idempotency-Key": reference}
        payload = {"restaurant_id": restaurant_id, "address": "Prueba efimera Tala Centro",
                   "order_type": "delivery", "distance_km": 1.0, "payment_method": "cash",
                   "client_reference": reference, "items": [{"menu_item_id": item_id, "quantity": 1}]}
        first = client_http.post("/api/v1/orders", headers=header, json=payload)
        assert first.status_code == 201, ("First QA order", first.status_code, first.text[:500])
        again = client_http.post("/api/v1/orders", headers=header, json=payload)
        assert again.status_code == 201, ("Replay", again.status_code, again.text[:500])
        assert first.json()["id"] == again.json()["id"]
        assert again.headers.get("x-idempotency-replayed") == "true", "Redis replay cache did not engage"
        changed = {**payload, "items": [{"menu_item_id": item_id, "quantity": 2}]}
        conflict = client_http.post("/api/v1/orders", headers=header, json=changed)
        assert conflict.status_code == 409, ("Key collision must fail closed", conflict.status_code, conflict.text[:350])
        with SessionLocal() as db:
            count = db.scalar(select(func.count(models.Order.id)).where(models.Order.client_reference == reference))
            stock_after = db.get(models.MenuItem, item_id).stock
        assert count == 1 and stock_after == stock_before - 1, (count, stock_before, stock_after)
    print("POSTGRES_REDIS_QA_PASS migration", heads[0],
          "immutable triggers, unique order references, cash order once, replay, collision 409, auth, readiness")

if __name__ == "__main__":
    main()
