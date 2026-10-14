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
    print("POSTGRES_REDIS_QA_PASS migration", heads[0], "immutable triggers, unique order references, auth, redis TTL, readiness")

if __name__ == "__main__":
    main()
