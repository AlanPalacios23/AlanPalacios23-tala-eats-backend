"""F2.01 isolated PostgreSQL upgrade from f20h -> f21i with historical data.

This is a CI-only, *second database* created on the exact Docker Postgres
fixture. Not a production migration or a claim of Kali version equivalence.
No real user, location, vendor, finance or LIVE data is accessed.
"""
import argparse
from datetime import datetime, timezone
from decimal import Decimal
import os
import re
import subprocess
import sys
from uuid import uuid4

import psycopg
from psycopg import sql
from sqlalchemy import Boolean, DateTime, Float, Integer, Numeric, String, create_engine, inspect, text

from app.config import settings

EXPECTED = "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa"
ROOT_ADMIN_DSN = "postgresql://talaqa:qa-only-local@127.0.0.1:5432/postgres"
DB_PREFIX = "talaqa_phase2_"
F20 = "f20h00000001"
HEAD = "f21i00000001"


def ensure_ci_fixture() -> None:
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("DATABASE_URL") == EXPECTED == settings.database_url
    assert os.environ.get("REDIS_URL") == "redis://127.0.0.1:6379/0"
    assert settings.environment == "development" and not settings.seed_demo_data
    assert not settings.stripe_enabled and not settings.stripe_secret_key
    assert not settings.stripe_connect_enabled
    assert not settings.withdrawals_execution_enabled
    assert not settings.withdrawals_live_enabled
    assert not settings.mercado_pago_access_token


def safe_db_name(value: str) -> str:
    if not re.fullmatch(r"talaqa_phase2_[0-9a-f]{24}", value):
        raise ValueError("Refuse a database name outside the random CI namespace")
    return value


def required_seed_values(column) -> object:
    name = column["name"]
    known = {
        "name": "Historical QA Merchant",
        "description": "Synthetic migration record",
        "cuisine": "QA",
        "emoji": "Q",
        "eta_min": 25,
        "delivery_fee": Decimal("35.00"),
        "is_open": True,
        "lat": 20.6526,
        "lng": -103.7035,
        "delivery_radius_km": 14.0,
        "per_km_fee": Decimal("5.00"),
        "pickup_enabled": True,
        "sponsored": False,
        "rating": Decimal("4.50"),
        "verification_status": "verified",
        "pos_webhook_url": "",
        "tax_id": "QA-ONLY",
        "created_at": datetime.now(timezone.utc),
    }
    if name in known:
        return known[name]
    kind = column["type"]
    if isinstance(kind, Boolean):
        return False
    if isinstance(kind, DateTime):
        return datetime.now(timezone.utc)
    if isinstance(kind, Numeric):
        return Decimal("0.00")
    if isinstance(kind, Float):
        return 0.0
    if isinstance(kind, Integer):
        return 0
    if isinstance(kind, String):
        return "QA"
    raise RuntimeError(f"Unrecognized mandatory synthetic merchant column: {name}")


def alembic_to(db_url: str, version: str):
    env = {**os.environ, "DATABASE_URL": db_url, "SEED_DEMO_DATA": "false"}
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", version],
        env=env, timeout=130, check=False, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True,
    )
    if result.returncode:
        # Don't print stderr (could contain URL and credentials).
        raise AssertionError(f"isolated Alembic upgrade to {version} failed")


def migrate_and_verify(db_url: str) -> None:
    alembic_to(db_url, F20)
    engine = create_engine(db_url)
    try:
        inspector = inspect(engine)
        original_columns = inspector.get_columns("restaurants")
        assert "address" not in {column["name"] for column in original_columns}
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == F20
            source = {
                col["name"]: required_seed_values(col)
                for col in original_columns
                if col["name"] != "id"
                and ((not col["nullable"] and col.get("default") is None)
                     or col["name"] in {"lat", "lng", "name", "delivery_radius_km"})
            }
            assert source["lat"] == 20.6526 and source["lng"] == -103.7035
            assert source["name"] == "Historical QA Merchant"
            assert all(name.isidentifier() for name in source)
            names = ", ".join(source)
            params = ", ".join(":" + key for key in source)
            record_id = connection.execute(
                text(f"INSERT INTO restaurants ({names}) VALUES ({params}) RETURNING id"), source
            ).scalar_one()
            before = connection.execute(text(
                "SELECT name,lat,lng,delivery_radius_km FROM restaurants WHERE id=:id"
            ), {"id": record_id}).one()
        engine.dispose()

        alembic_to(db_url, "head")
        engine = create_engine(db_url)
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == HEAD
            assert "address" in {col["name"] for col in inspect(engine).get_columns("restaurants")}
            after = connection.execute(text(
                "SELECT name,lat,lng,delivery_radius_km,address FROM restaurants WHERE id=:id"
            ), {"id": record_id}).one()
            assert after[:4] == before[:4], (before, after)
            assert after.address == ""
            connection.execute(text(
                "UPDATE restaurants SET address='QA Local 123' WHERE id=:id"
            ), {"id": record_id})
            assert connection.scalar(text(
                "SELECT address FROM restaurants WHERE id=:id"
            ), {"id": record_id}) == "QA Local 123"
        print("F201_HISTORICAL_F20_TO_F21_POSTGRES_PASS: metadata, GPS unchanged, "
              "address backfill empty, update works, separate CI DB, no LIVE")
    finally:
        engine.dispose()


def main():
    ensure_ci_fixture()
    name = safe_db_name(DB_PREFIX + uuid4().hex[:24])
    created = False
    with psycopg.connect(ROOT_ADMIN_DSN, autocommit=True) as admin:
        try:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
            created = True
            migrate_and_verify(
                f"postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/{name}"
            )
        finally:
            if created:
                # The random database was created by this exact process on
                # disposable CI. Never drop anything else.
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    sql.Identifier(safe_db_name(name))
                ))


def self_test():
    for invalid in ["postgres", "talaqa", "talaqa_phase2_", "talaqa_phase2_ABC",
                    "talaqa_phase2_" + "a" * 25]:
        try:
            safe_db_name(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("Accepted non-ephemeral database identifier")
    assert safe_db_name("talaqa_phase2_" + "f" * 24).startswith(DB_PREFIX)
    print("F201_ISOLATED_MIGRATION_GUARD_SELFTEST_PASS")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    options = parser.parse_args()
    if options.self_test:
        self_test()
    else:
        main()
