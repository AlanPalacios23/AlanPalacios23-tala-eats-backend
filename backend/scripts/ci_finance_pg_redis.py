#!/usr/bin/env python3
"""PostgreSQL/Redis money-safety smoke on disposable GitHub Actions services.

No remote Stripe calls, payouts, accounts, transfers or actual bank details.
This module must NOT run against a production database.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError


def _require_ci() -> None:
    # Fail-closed before importing app/db or touching any database.
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("TALAEATS_DISPOSABLE_FINANCE_CI") != "YES":
        raise SystemExit("DENIED: requires disposable GitHub Actions finance CI context")
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url.startswith("postgresql+psycopg://ci_tala:") or "@127.0.0.1:5432/talaeats_ci" not in db_url:
        raise SystemExit("DENIED: database must be the dedicated local CI PostgreSQL service")
    if os.environ.get("ENVIRONMENT") != "development":
        raise SystemExit("DENIED: environment must be development")
    for name in ("STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET",
                 "STRIPE_CONNECT_WEBHOOK_SECRET", "MERCADOPAGO_ACCESS_TOKEN"):
        if os.environ.get(name):
            raise SystemExit("DENIED: finance CI must have no payment credentials")
    for name in ("STRIPE_ENABLED", "STRIPE_CONNECT_ENABLED",
                 "STRIPE_CONNECT_SELF_SERVICE_ENABLED", "WITHDRAWALS_PREVIEW_ENABLED",
                 "WITHDRAWALS_EXECUTION_ENABLED", "WITHDRAWALS_LIVE_ENABLED"):
        if os.environ.get(name, "false").lower() not in ("false", "0"):
            raise SystemExit("DENIED: all payment/execution switches must remain OFF")


def main() -> None:
    _require_ci()
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    from app.db import engine, SessionLocal
    from app.seed import seed_database
    from app import models
    from app.routes import withdrawals
    import redis

    cfg = Config("alembic.ini")
    heads = ScriptDirectory.from_config(cfg).get_heads()
    assert len(heads) == 1, f"Expected single migration head, got {heads}"
    with engine.connect() as connection:
        actual = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        assert actual == heads[0], (actual, heads)
        version = int(connection.execute(text("SHOW server_version_num")).scalar_one())
        assert version >= 160000, version
        assert connection.execute(text("SELECT to_regclass('public.withdrawal_requests')")).scalar_one()
        assert connection.execute(text("SELECT to_regclass('public.stripe_transfers')")).scalar_one()
    print("PG16_ALEMBIC_SCHEMA_PASS")

    # Two distinct connections prove real PostgreSQL locking (not SQLite mocks).
    with engine.connect() as first, engine.connect() as second:
        key = 2026101504
        assert first.execute(text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": key}).scalar_one() is True
        assert second.execute(text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": key}).scalar_one() is False
        first.rollback()
        assert second.execute(text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": key}).scalar_one() is True
        second.rollback()
    print("PG_TRANSACTION_LOCK_PASS")

    r = redis.Redis.from_url(os.environ["REDIS_URL"], socket_timeout=3, decode_responses=True)
    assert r.ping()
    key = "talaeats:ci:finance:" + uuid4().hex
    try:
        assert r.set(key, "1", nx=True, ex=35) is True
        assert r.set(key, "2", nx=True, ex=35) is None
        assert r.get(key) == "1"
        assert r.ttl(key) > 0
    finally:
        r.delete(key)
    print("REDIS_ATOMIC_DEDUP_PASS")

    with SessionLocal() as db:
        seed_database(db)
        owner = db.scalar(select(models.User).where(models.User.role == "restaurant"))
        driver = db.scalar(select(models.User).where(models.User.role == "driver"))
        customer = db.scalar(select(models.User).where(models.User.role == "customer"))
        assert owner and driver and customer
        rest = db.scalar(select(models.Restaurant).where(models.Restaurant.owner_id == owner.id))
        profile = db.scalar(select(models.DriverProfile).where(models.DriverProfile.user_id == driver.id))
        assert rest and profile
        rest.payout_account_ref = "acct_CI_RESTAURANT_TEST_1234"
        profile.payout_account_ref = "acct_CI_DRIVER_TEST_123456"
        order = models.Order(
            user_id=customer.id, restaurant_id=rest.id, driver_id=driver.id,
            status="delivered", payment_method="stripe", payment_status="paid",
            payment_provider_id="pi_ci_disposable", address="CI Tala",
            restaurant_payout=Decimal("85.00"), driver_earning=Decimal("42.00"),
            tip=Decimal("8.00"), total=Decimal("160.00"),
            refunded_amount=Decimal("0.00"), order_type="delivery",
            delivered_at=datetime.now(timezone.utc) - timedelta(days=10),
        )
        db.add(order)
        db.flush()
        db.add_all([
            models.StripeTransfer(order_id=order.id, recipient_type="restaurant",
                                  connected_account_id=rest.payout_account_ref, amount_cents=8500,
                                  transfer_id="tr_ci_restaurant", status="completed"),
            models.StripeTransfer(order_id=order.id, recipient_type="driver",
                                  connected_account_id=profile.payout_account_ref, amount_cents=5000,
                                  transfer_id="tr_ci_driver", status="completed"),
        ])
        db.commit()

        total, _ = withdrawals._eligible(db, "restaurant", rest.id, rest.payout_account_ref)
        assert total == 8500, total
        total, _ = withdrawals._eligible(db, "driver", driver.id, profile.payout_account_ref)
        assert total == 5000, total
        order.payment_method = "cash"
        db.flush()
        assert withdrawals._eligible(db, "restaurant", rest.id, rest.payout_account_ref)[0] == 0
        db.rollback()
        order = db.get(models.Order, order.id)
        order.delivered_at = datetime.now(timezone.utc) - timedelta(days=1)
        db.flush()
        assert withdrawals._eligible(db, "restaurant", rest.id, rest.payout_account_ref)[0] == 0
        db.rollback()
        order = db.get(models.Order, order.id)
        order.refunded_amount = Decimal("5.00")
        db.flush()
        assert withdrawals._eligible(db, "restaurant", rest.id, rest.payout_account_ref)[0] == 0
        db.rollback()
        print("PG_REAL_MONEY_ELIGIBILITY_NEGATIVES_PASS")

        original = models.WithdrawalRequest(
            payee_type="restaurant", payee_id=rest.id, requested_by=owner.id,
            connected_account_id=rest.payout_account_ref,
            client_key="ci-idempotency-key-123", amount_cents=1000, otp_step=10001,
            status="reserved",
        )
        db.add(original)
        db.commit()
        try:
            with db.begin_nested():
                db.add(models.WithdrawalRequest(
                    payee_type="restaurant", payee_id=rest.id, requested_by=owner.id,
                    connected_account_id=rest.payout_account_ref,
                    client_key="ci-idempotency-key-123", amount_cents=1000,
                    otp_step=10002, status="reserved",
                ))
                db.flush()
        except IntegrityError:
            pass
        else:
            raise AssertionError("Duplicate withdrawal key was NOT rejected by PostgreSQL")
        try:
            with db.begin_nested():
                db.add(models.WithdrawalRequest(
                    payee_type="restaurant", payee_id=rest.id, requested_by=owner.id,
                    connected_account_id=rest.payout_account_ref,
                    client_key="ci-another-key-123456", amount_cents=1000,
                    otp_step=10001, status="reserved",
                ))
                db.flush()
        except IntegrityError:
            pass
        else:
            raise AssertionError("Duplicate one-time TOTP step was NOT rejected by PostgreSQL")
        print("PG_IDEMPOTENCY_AND_TOTP_UNIQUE_PASS")

    print("FINANCE_CI_DISPOSABLE_PASS_NO_STRIPE_NETWORK_NO_LIVE")


if __name__ == "__main__":
    main()
