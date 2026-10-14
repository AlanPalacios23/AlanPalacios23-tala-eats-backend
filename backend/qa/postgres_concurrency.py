"""Concurrent PostgreSQL checkout contract, executed ONLY against disposable QA services.

No Stripe network; no LIVE funds, no Kali DB.
"""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from sqlalchemy import select, func
from app import models, schemas
from app.config import settings
from app.db import SessionLocal
from app.routes.orders import create_order

EXPECTED = "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa"

def _guard():
    assert os.environ.get("DATABASE_URL") == EXPECTED
    assert settings.database_url == EXPECTED
    assert settings.environment == "development"
    assert not settings.stripe_enabled and not settings.stripe_secret_key
    assert not settings.withdrawals_execution_enabled
    assert not settings.withdrawals_live_enabled
    assert not settings.mercado_pago_access_token

def main():
    _guard()
    with SessionLocal() as db:
        user = db.scalar(select(models.User).where(models.User.email == "cliente@talaeats.mx"))
        restaurant = db.scalar(select(models.Restaurant).where(models.Restaurant.name == "Tacos El Centro"))
        assert user and restaurant
        item = db.scalar(select(models.MenuItem).where(models.MenuItem.restaurant_id == restaurant.id).order_by(models.MenuItem.id))
        assert item and item.stock >= 2, "QA fixture insufficient"
        customer_id, restaurant_id, item_id = user.id, restaurant.id, item.id
        stock_start = item.stock

    ref = "qa-concurrent-" + uuid.uuid4().hex
    payload = schemas.OrderCreate.model_validate({
        "restaurant_id": restaurant_id, "address": "Prueba concurrente Tala Centro",
        "order_type": "pickup", "payment_method": "cash", "client_reference": ref,
        "items": [{"menu_item_id": item_id, "quantity": 1}]
    })
    barrier = Barrier(2, timeout=15)

    def worker(_):
        with SessionLocal() as db:
            account = db.get(models.User, customer_id)
            barrier.wait()
            return create_order(payload, user=account, db=db).id

    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="qa-same-reference") as pool:
        ids = list(pool.map(worker, (0, 1)))

    assert ids[0] == ids[1], ("Concurrent replay created different orders", ids)
    with SessionLocal() as db:
        matching = db.scalars(select(models.Order).where(
            models.Order.user_id == customer_id,
            models.Order.client_reference == ref
        )).all()
        stock_end = db.get(models.MenuItem, item_id).stock
        assert len(matching) == 1
        assert stock_end == stock_start - 1, (stock_start, stock_end)
        order_id = matching[0].id
        outbox_count = db.scalar(select(func.count(models.EventOutbox.id)).where(
            models.EventOutbox.aggregate_id == str(order_id),
            models.EventOutbox.event_type == "order.created"
        ))
        assert outbox_count == 1, outbox_count
    print("PG_CONCURRENT_ORDER_PASS", "one order, one stock unit, one outbox event")

if __name__ == "__main__":
    main()
