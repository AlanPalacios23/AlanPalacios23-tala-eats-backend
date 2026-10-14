"""Production safety regressions; provider/network calls replaced with fakes."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import models, native_push, worker
from app.config import settings
from app.db import SessionLocal
from app.routes import stripe_payments, v11


def _user(db, email='cliente@talaeats.mx'):
    return db.scalar(select(models.User).where(models.User.email == email))


def test_browser_promotions_do_not_bypass_consent(monkeypatch):
    monkeypatch.setattr(settings, 'web_push_vapid_public_key', 'mock-public-key')
    monkeypatch.setattr(settings, 'web_push_vapid_private_key', 'mock-private-key')
    calls = []
    monkeypatch.setattr(worker, 'send_web_push', lambda endpoint, title, message, **kwargs:
                        (calls.append(title) or SimpleNamespace(ok=True, status='sent', detail='')))
    with SessionLocal() as db:
        user = _user(db)
        user.marketing_opt_in = False
        db.add(models.PushSubscription(user_id=user.id, endpoint='https://push.example.test/v160',
                 p256dh='some-public', auth='some-auth', active=True))
        db.add(models.Notification(user_id=user.id, kind='growth', title='Publicidad', message='Promo sin permiso'))
        db.add(models.Notification(user_id=user.id, kind='order', title='Pedido confirmado', message='Tu pedido va bien'))
        db.commit()
    sent, failed = worker.deliver_v11_push_notifications()
    assert (sent, failed) == (1, 0)
    assert calls == ['Pedido confirmado']
    with SessionLocal() as db:
        suppressions = db.scalars(select(models.AuditEvent).where(models.AuditEvent.detail == 'suppressed:no_marketing_consent')).all()
        assert len(suppressions) >= 1
        _user(db).marketing_opt_in = True
        db.commit()
    assert worker.deliver_v11_push_notifications() == (0, 0)


def test_browser_subscription_reassigned_without_cross_account_leak():
    with SessionLocal() as db:
        a = _user(db)
        b = _user(db, 'repartidor@talaeats.mx')
        sub = models.PushSubscription(user_id=a.id, endpoint='https://push.example.test/same-endpoint',
                   p256dh='aaa', auth='bbb', active=True)
        db.add(sub)
        db.commit()
        sid = sub.id
    with SessionLocal() as db:
        b = _user(db, 'repartidor@talaeats.mx')
        v11.save_push_subscription(SimpleNamespace(endpoint='https://push.example.test/same-endpoint',
              p256dh='ccc', auth='ddd', platform='web', device_label='moved',
              model_dump=lambda: {'endpoint':'https://push.example.test/same-endpoint', 'p256dh':'ccc','auth':'ddd','platform':'web','device_label':'moved'}),
              user=b, db=db)
    with SessionLocal() as db:
        assert db.get(models.PushSubscription, sid).active is False
        active = db.scalars(select(models.PushSubscription).where(models.PushSubscription.active.is_(True))).all()
        assert len(active) == 1
        assert active[0].user_id == _user(db, 'repartidor@talaeats.mx').id


def test_native_push_short_expiration_for_orders():
    now = datetime.now(timezone.utc)
    assert native_push._order_notification(SimpleNamespace(kind='order', message='Cambio de estado')) is True
    assert native_push._order_notification(SimpleNamespace(kind='restaurant_order', message='Confirmado')) is True
    assert native_push._order_notification(SimpleNamespace(kind='promotion', message='Oferta')) is False


def test_stripe_refund_cannot_race_with_pending_transfer(monkeypatch):
    monkeypatch.setattr(stripe_payments, 'stripe_client', lambda: object())
    monkeypatch.setattr(stripe_payments, 'refund_create', lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('refund forbidden')))
    with SessionLocal() as db:
        customer = _user(db)
        restaurant = db.scalar(select(models.Restaurant))
        order = models.Order(user_id=customer.id, restaurant_id=restaurant.id,
                             payment_method='stripe', payment_provider_id='pi_test_160',
                             payment_status='paid', status='delivered', address='Tala', total=Decimal('120.00'))
        db.add(order)
        db.flush()
        db.add(models.StripeTransfer(order_id=order.id, recipient_type='restaurant',
                  connected_account_id='acct_testing_160', amount_cents=8500, status='pending'))
        db.commit()
        with pytest.raises(HTTPException) as err:
            stripe_payments.refund(order.id, None, db)
        assert err.value.status_code == 409
        assert 'liquidación iniciada' in err.value.detail


def test_production_rejects_unusable_fcm_credentials(monkeypatch):
    monkeypatch.setattr(settings, 'environment', 'production')
    monkeypatch.setattr(settings, 'native_push_enabled', True)
    monkeypatch.setattr(settings, 'fcm_project_id', 'bad project')
    monkeypatch.setattr(settings, 'fcm_credentials_file', '/not/a/real/firebase-credential.json')
    monkeypatch.setattr(settings, 'fcm_token_encryption_key', 'not-a-fernet-key')
    with pytest.raises(RuntimeError) as error:
        settings.validate_production()
    text = str(error.value)
    assert 'FCM_PROJECT_ID' in text
    assert 'FCM_CREDENTIALS_FILE' in text
    assert 'FCM_TOKEN_ENCRYPTION_KEY' in text
