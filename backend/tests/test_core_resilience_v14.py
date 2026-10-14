from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import models
from app.db import SessionLocal
from app.main import app
from app.monetization import post_refund_ledger
from app.order_state import InvalidOrderTransition
from app.outbox import enqueue_event, process_outbox


def login(client, email, password, **headers):
    r = client.post('/api/v1/auth/login', json={'email': email, 'password': password}, headers=headers)
    assert r.status_code == 200, r.text
    return {'Authorization': f"Bearer {r.json()['access_token']}"}


def test_global_state_machine_rejects_impossible_jump():
    with SessionLocal() as db:
        user = db.scalar(select(models.User).where(models.User.role == 'customer'))
        restaurant = db.scalar(select(models.Restaurant))
        order = models.Order(user_id=user.id, restaurant_id=restaurant.id, status='received', address='Tala', total=Decimal('100.00'))
        db.add(order); db.commit(); db.refresh(order)
        order.status = 'delivered'
        with pytest.raises(InvalidOrderTransition):
            db.flush()
        db.rollback()


def test_order_creation_generates_durable_outbox_event():
    with TestClient(app) as c:
        auth = login(c, 'cliente@talaeats.mx', 'Cliente123!')
        detail = c.get('/api/v1/restaurants/1').json()
        item = detail['menu_items'][0]
        r = c.post('/api/v1/orders', headers=auth, json={
            'restaurant_id': 1, 'address': 'Centro, Tala, Jalisco', 'payment_method': 'cash',
            'distance_km': 1.0, 'items': [{'menu_item_id': item['id'], 'quantity': 1}]
        })
        assert r.status_code == 201, r.text
        oid = r.json()['id']
    with SessionLocal() as db:
        row = db.scalar(select(models.EventOutbox).where(models.EventOutbox.aggregate_id == str(oid), models.EventOutbox.event_type == 'order.created'))
        assert row is not None
        assert row.status == 'pending'


def test_outbox_drain_marks_event_published(monkeypatch):
    published = []
    monkeypatch.setattr('app.outbox._publish', lambda row: published.append((row.event_type, row.aggregate_id)))
    with SessionLocal() as db:
        row = enqueue_event(db, event_key='test:v14:durable', aggregate_type='order', aggregate_id=991, event_type='order.test', payload={'order_id': 991})
        db.commit(); db.refresh(row)
        published_count, retried, dead = process_outbox(db, limit=50)
        assert published_count >= 1 and retried == 0 and dead == 0
        db.refresh(row)
        assert row.status == 'published'
        assert row.published_at is not None
    assert ('order.test', '991') in published


def test_refund_ledger_is_idempotent_and_compensating():
    with SessionLocal() as db:
        user = db.scalar(select(models.User).where(models.User.role == 'customer'))
        restaurant = db.scalar(select(models.Restaurant))
        order = models.Order(user_id=user.id, restaurant_id=restaurant.id, status='received', address='Tala', total=Decimal('125.00'))
        db.add(order); db.commit(); db.refresh(order)
        post_refund_ledger(db, order, Decimal('125.00'), idempotency_suffix='test-v14')
        post_refund_ledger(db, order, Decimal('125.00'), idempotency_suffix='test-v14')
        db.commit()
        rows = db.scalars(select(models.FinancialLedgerEntry).where(models.FinancialLedgerEntry.order_id == order.id)).all()
        assert len(rows) == 2
        assert {(r.account, r.direction) for r in rows} == {('gmv', 'debit'), ('customer_refund_payable', 'credit')}
        assert sum(Decimal(r.amount) for r in rows) == Decimal('250.00')


def test_audit_event_captures_request_and_device_context():
    device = 'ios-installation-v14-test'
    with TestClient(app) as c:
        auth = login(c, 'cliente@talaeats.mx', 'Cliente123!', **{'X-Device-ID': device, 'X-TalaEats-Client': 'mobile'})
        headers = {**auth, 'X-Device-ID': device, 'X-TalaEats-Client': 'mobile'}
        r = c.patch('/api/v1/auth/me', headers=headers, json={'name': 'Cliente Auditado'})
        assert r.status_code == 200, r.text
    with SessionLocal() as db:
        audit = db.scalar(select(models.AuditEvent).where(models.AuditEvent.action == 'profile.update').order_by(models.AuditEvent.id.desc()))
        assert audit is not None
        assert audit.request_id
        assert audit.ip_address
        assert audit.device_session_id is not None


def test_resilience_console_is_admin_only_and_reports_core_components():
    with TestClient(app) as c:
        customer = login(c, 'cliente@talaeats.mx', 'Cliente123!')
        denied = c.get('/api/v1/resilience/status', headers=customer)
        assert denied.status_code == 403
        admin = login(c, 'admin@talaeats.mx', 'Admin123!')
        ok = c.get('/api/v1/resilience/status', headers=admin)
        assert ok.status_code == 200, ok.text
        body = ok.json()
        assert body['version'] == '1.4.0-core-resilience'
        assert body['state_machine'] == 'global-sqlalchemy-guard'
        assert 'outbox' in body and 'circuit_breakers' in body


def test_catalog_write_creates_cache_invalidation_event():
    with SessionLocal() as db:
        restaurant = db.scalar(select(models.Restaurant))
        before = db.scalar(select(func.count(models.EventOutbox.id)).where(models.EventOutbox.event_type == 'catalog.changed')) or 0
        restaurant.description = restaurant.description + ' v14'
        db.commit()
        after = db.scalar(select(func.count(models.EventOutbox.id)).where(models.EventOutbox.event_type == 'catalog.changed')) or 0
        assert after == before + 1


def test_audit_events_are_append_only_at_orm_layer():
    with SessionLocal() as db:
        row = models.AuditEvent(action='v14.immutable.test', entity_type='test', entity_id='1', detail='original')
        db.add(row); db.commit(); db.refresh(row)
        row.detail = 'tampered'
        with pytest.raises(RuntimeError, match='append-only'):
            db.flush()
        db.rollback()


def test_device_inventory_and_selective_revocation():
    with TestClient(app) as c:
        first = login(c, 'cliente@talaeats.mx', 'Cliente123!', **{'X-Device-ID': 'v14-device-a', 'X-TalaEats-Client': 'mobile'})
        second = login(c, 'cliente@talaeats.mx', 'Cliente123!', **{'X-Device-ID': 'v14-device-b', 'X-TalaEats-Client': 'mobile'})
        listing = c.get('/api/v1/auth/devices', headers=first)
        assert listing.status_code == 200, listing.text
        active = [row for row in listing.json() if row['active']]
        assert len(active) >= 2
        current = next(row for row in active if row['current'])
        target = next(row for row in active if not row['current'])
        revoked = c.post(f"/api/v1/auth/devices/{target['id']}/revoke", headers=first)
        assert revoked.status_code == 200, revoked.text
        assert revoked.json()['revoked'] is True
        denied = c.get('/api/v1/auth/me', headers=second)
        assert denied.status_code == 401
        still_ok = c.get('/api/v1/auth/me', headers=first)
        assert still_ok.status_code == 200
        assert current['id'] != target['id']


def test_auth_login_does_not_replay_stale_token_or_share_idempotency_cache(monkeypatch):
    from app import middleware
    from app.config import settings

    class FakePipeline:
        def __init__(self, store): self.store = store; self.ops = []
        def incr(self, key): self.ops.append(('incr', key)); return self
        def expire(self, key, ttl): self.ops.append(('expire', key, ttl)); return self
        async def execute(self):
            result = []
            for op in self.ops:
                if op[0] == 'incr':
                    value = int(self.store.get(op[1], '0')) + 1
                    self.store[op[1]] = str(value); result.append(value)
                elif op[0] == 'expire': result.append(True)
            return result

    class FakeRedis:
        def __init__(self): self.store = {}
        async def get(self, key): return self.store.get(key)
        async def set(self, key, value, nx=False, ex=None):
            if nx and key in self.store: return False
            self.store[key] = str(value); return True
        async def delete(self, key): self.store.pop(key, None); return 1
        def pipeline(self, transaction=True): return FakePipeline(self.store)

    fake = FakeRedis()
    async def fake_get_redis(): return fake
    monkeypatch.setattr(middleware, '_get_rate_redis', fake_get_redis)
    monkeypatch.setattr(settings, 'redis_url', 'redis://fake')

    headers = {'Idempotency-Key': 'v14-login-idem-0001', 'X-TalaEats-Client': 'mobile'}
    with TestClient(app) as c:
        one = c.post('/api/v1/auth/login', headers=headers, json={'email': 'cliente@talaeats.mx', 'password': 'Cliente123!'})
        assert one.status_code == 200, one.text
        replay = c.post('/api/v1/auth/login', headers=headers, json={'email': 'cliente@talaeats.mx', 'password': 'Cliente123!'})
        assert replay.status_code == 200, replay.text
        # A new login is always authenticated; token/cookie results are never
        # replayed from Redis under a user-controlled Idempotency-Key.
        assert replay.headers.get('X-Idempotency-Replayed') is None
        mismatch = c.post('/api/v1/auth/login', headers=headers, json={'email': 'cliente@talaeats.mx', 'password': 'wrong-password'})
        assert mismatch.status_code == 401, mismatch.text
        assert not any(key.startswith('idem:response:') for key in fake.store)
        assert not any(key.startswith('idem:signature:') for key in fake.store)


def test_signed_device_attestation_binds_user_and_installation():
    with TestClient(app) as c:
        device = 'v14-signed-installation-a'
        r = c.post(
            '/api/v1/auth/login',
            json={'email': 'cliente@talaeats.mx', 'password': 'Cliente123!'},
            headers={'X-Device-ID': device, 'X-TalaEats-Client': 'mobile'},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body['device_token']
        headers = {
            'Authorization': f"Bearer {body['access_token']}",
            'X-Device-ID': device,
            'X-Device-Token': body['device_token'],
            'X-TalaEats-Client': 'mobile',
        }
        ok = c.get('/api/v1/auth/me', headers=headers)
        assert ok.status_code == 200, ok.text
        headers['X-Device-ID'] = 'tampered-installation'
        denied = c.get('/api/v1/auth/me', headers=headers)
        assert denied.status_code == 401
        assert 'dispositivo' in denied.json()['detail'].lower()
