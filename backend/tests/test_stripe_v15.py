"""Stripe isolated tests: no real keys, payments or external API calls."""
from decimal import Decimal
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select

from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app
from app.stripe_gateway import money_cents


def login(c, email, pw):
    r = c.post('/api/v1/auth/login', json={'email': email, 'password': pw})
    assert r.status_code == 200, r.text
    return {'Authorization': 'Bearer ' + r.json()['access_token']}


def prep(monkeypatch):
    monkeypatch.setattr(settings, 'stripe_enabled', True)
    monkeypatch.setattr(settings, 'stripe_secret_key', 'sk_test_fake_locally_only')
    monkeypatch.setattr(settings, 'stripe_publishable_key', 'pk_test_fake_locally_only')
    monkeypatch.setattr(settings, 'stripe_webhook_secret', 'whsec_fake_local_only')
    monkeypatch.setattr('app.routes.stripe_payments.stripe_client', lambda: object())


def create(c, headers):
    item = c.get('/api/v1/restaurants/1').json()['menu_items'][0]
    r = c.post('/api/v1/orders', headers=headers, json={
        'restaurant_id':1, 'address':'Centro de Tala, Jalisco', 'payment_method':'stripe',
        'client_reference':'s15-'+uuid4().hex, 'order_type':'pickup',
        'items':[{'menu_item_id':item['id'], 'quantity':1}],
    })
    assert r.status_code == 201, r.text
    return r.json()


def webhook(c, monkeypatch, oid, typ, amount_cents, event_id='evt_test1', intent_id='pi_test_1'):
    obj = {'id': intent_id, 'currency':'mxn', 'amount':amount_cents,
           'metadata':{'tala_order_id':str(oid)}}
    monkeypatch.setattr('app.routes.stripe_payments.parse_webhook', lambda *a,**k: {
        'id':event_id, 'livemode':False, 'type':typ, 'data':{'object':obj}
    })
    return c.post('/api/v1/payments/stripe/webhook', data=b'{}', headers={'stripe-signature':'test'})


def test_stripe_disabled_by_default():
    with TestClient(app) as c:
        assert c.get('/api/v1/payments/stripe/config').json()['enabled'] is False
        customer = login(c, 'cliente@talaeats.mx', 'Cliente123!')
        item = c.get('/api/v1/restaurants/1').json()['menu_items'][0]
        r = c.post('/api/v1/orders',headers=customer,json={'restaurant_id':1,'address':'Tala, Jalisco',
                   'payment_method':'stripe','order_type':'pickup','items':[{'menu_item_id':item['id'],'quantity':1}]})
        assert r.status_code == 503


def test_stripe_fee_and_processing_estimate_do_not_modify_cash(monkeypatch):
    prep(monkeypatch)
    with TestClient(app) as c:
        customer = login(c, 'cliente@talaeats.mx', 'Cliente123!')
        order = create(c, customer)
        assert Decimal(str(order['service_fee'])) > Decimal('0')
        assert Decimal(str(order['payment_processing_fee'])) > Decimal('0')
        assert Decimal(str(order['total'])) == (Decimal(str(order['subtotal'])) - Decimal(str(order['discount'])) + Decimal(str(order['service_fee'])) + Decimal(str(order['tip'])) + Decimal(str(order['delivery_fee'])))


def test_stripe_intent_idempotency_and_success_webhook(monkeypatch):
    prep(monkeypatch)
    calls = []
    def create_pi(client, order, key):
        calls.append(key)
        return {'id':'pi_test_1','currency':'mxn', 'amount':money_cents(order.total),
                'client_secret':'pi_test_secret_ABC','status':'requires_payment_method',
                'metadata':{'tala_order_id':str(order.id)}}
    monkeypatch.setattr('app.routes.stripe_payments.intent_create', create_pi)
    monkeypatch.setattr('app.routes.stripe_payments.intent_retrieve', lambda cli,id: {'id':'pi_test_1','currency':'mxn',
           'amount':amount_cents, 'client_secret':'pi_test_secret_ABC','status':'requires_payment_method',
           'metadata':{'tala_order_id':str(oid)}})
    with TestClient(app) as c:
        customer = login(c, 'cliente@talaeats.mx', 'Cliente123!')
        order = create(c, customer)
        oid = order['id']; amount_cents = money_cents(order['total'])
        a = c.post(f'/api/v1/payments/stripe/orders/{oid}/payment-intent',headers=customer)
        assert a.status_code == 200, a.text
        assert a.json()['amount_cents'] == amount_cents
        b = c.post(f'/api/v1/payments/stripe/orders/{oid}/payment-intent',headers=customer)
        assert b.status_code == 200 and a.json()['payment_intent_id'] == b.json()['payment_intent_id']
        assert len(calls) == 1
        bad = webhook(c,monkeypatch,oid,'payment_intent.succeeded',amount_cents+1,'evt_bad_amt')
        assert bad.status_code == 409
        paid = webhook(c,monkeypatch,oid,'payment_intent.succeeded',amount_cents,'evt_good')
        assert paid.status_code == 200, paid.text
        replay = webhook(c,monkeypatch,oid,'payment_intent.succeeded',amount_cents,'evt_good')
        assert replay.status_code == 200 and replay.json()['duplicate'] is True
        detail = c.get(f'/api/v1/orders/{oid}',headers=customer).json()
        assert detail['payment_status'] == 'paid'
        with SessionLocal() as db:
            events = db.scalars(select(models.PaymentEvent).where(models.PaymentEvent.provider == 'stripe')).all()
            assert len(events) == 1
            outbox = db.scalars(select(models.EventOutbox).where(models.EventOutbox.aggregate_id == str(oid),models.EventOutbox.event_type == 'payment.stripe_updated')).all()
            assert len(outbox) == 1


def test_stripe_unpaid_cancel_restores_stock_and_repeat_no_mutation(monkeypatch):
    prep(monkeypatch)
    with TestClient(app) as c:
        customer = login(c,'cliente@talaeats.mx','Cliente123!')
        order = create(c, customer)
        oid = order['id']; amount_cents = money_cents(order['total'])
        with SessionLocal() as db:
            item_id = order['items'][0]['menu_item_id']
            reserved = db.get(models.MenuItem,item_id).stock
        response = webhook(c,monkeypatch,oid,'payment_intent.canceled',amount_cents,'evt_cancelled')
        assert response.status_code == 200, response.text
        with SessionLocal() as db:
            item = db.get(models.MenuItem,item_id)
            assert item.stock == reserved+1
            assert db.get(models.Order,oid).status == 'cancelled'
        replay = webhook(c,monkeypatch,oid,'payment_intent.canceled',amount_cents,'evt_cancelled')
        assert replay.json()['duplicate'] is True
        with SessionLocal() as db:
            assert db.get(models.MenuItem,item_id).stock == reserved+1


def test_stripe_unauthenticated_rejected_and_admin_refund_only(monkeypatch):
    prep(monkeypatch)
    with TestClient(app) as c:
        customer = login(c,'cliente@talaeats.mx','Cliente123!')
        order = create(c,customer)
        oid=order['id']
        c.cookies.clear()  # login() also set a valid HttpOnly session cookie
        unauthorized = c.post(f'/api/v1/payments/stripe/orders/{oid}/payment-intent')
        assert unauthorized.status_code in {401,403}
        web = c.post('/api/v1/payments/stripe/webhook',data=b'{}')
        assert web.status_code == 400
        refund = c.post(f'/api/v1/payments/stripe/admin/orders/{oid}/refund',headers=customer)
        assert refund.status_code in {401,403}
        sett = c.post(f'/api/v1/payments/stripe/admin/orders/{oid}/settle',headers=customer)
        assert sett.status_code in {401,403}


def test_late_stripe_approval_does_not_revive_expired_inventory(monkeypatch):
    prep(monkeypatch)
    monkeypatch.setattr('app.routes.stripe_payments.refund_create', lambda *a,**k:{'id':'re_test', 'status':'succeeded'})
    with TestClient(app) as c:
        customer=login(c,'cliente@talaeats.mx','Cliente123!')
        order=create(c,customer)
        oid=order['id']; amount=money_cents(order['total'])
        cancelled=c.post(f'/api/v1/orders/{oid}/cancel?reason=late',headers=customer)
        assert cancelled.status_code==200
        wh=webhook(c,monkeypatch,oid,'payment_intent.succeeded',amount,'evt_late')
        assert wh.status_code==200,wh.text
        final=c.get(f'/api/v1/orders/{oid}',headers=customer).json()
        assert final['status']=='cancelled' and final['payment_status']=='refunded'
        assert money_cents(final['refunded_amount'])==amount


def test_money_cents_precise():
    assert money_cents(Decimal('123.45')) == 12345
    assert money_cents(Decimal('0.005')) == 1
