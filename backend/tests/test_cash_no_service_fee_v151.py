"""Cash checkout policy: zero service fee, full inventory/ledger integrity."""
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app


@pytest.fixture(autouse=True)
def legacy_cash_policy(monkeypatch):
    monkeypatch.setattr(settings, 'commercial_pricing_v152_enabled', False)


def login(client, email, password):
    result = client.post('/api/v1/auth/login', json={'email': email, 'password': password})
    assert result.status_code == 200, result.text
    return {'Authorization': 'Bearer ' + result.json()['access_token']}


def create(client, auth, method, *, delivery=False, tip=0):
    item = client.get('/api/v1/restaurants/1').json()['menu_items'][0]
    payload = {
        'restaurant_id': 1, 'address': 'Tala, Jalisco',
        'payment_method': method, 'client_reference': 'cash151-' + uuid4().hex,
        'order_type': 'delivery' if delivery else 'pickup',
        'distance_km': 1.0, 'tip': tip,
        'items': [{'menu_item_id': item['id'], 'quantity': 1}],
    }
    result = client.post('/api/v1/orders', headers=auth, json=payload)
    assert result.status_code == 201, result.text
    return result.json(), payload


def cents(number):
    return Decimal(str(number))


def test_cash_pickup_has_zero_service_fee_and_keeps_restaurant_commission():
    with TestClient(app) as client:
        auth = login(client, 'cliente@talaeats.mx', 'Cliente123!')
        row, payload = create(client, auth, 'cash')
        assert cents(row['service_fee']) == 0
        assert cents(row['payment_processing_fee']) == 0
        assert cents(row['delivery_fee']) == 0
        assert cents(row['total']) == cents(row['subtotal']) - cents(row['discount'])
        assert cents(row['platform_commission']) > 0
        assert cents(row['restaurant_payout']) == cents(row['subtotal']) - cents(row['discount']) - cents(row['platform_commission'])
        assert row['payment_status'] == 'pending'
        assert row['payment_method'] == 'cash'
        with SessionLocal() as db:
            order = db.get(models.Order, row['id'])
            assert order.service_fee == 0
            ledger = db.scalars(select(models.FinancialLedgerEntry).where(models.FinancialLedgerEntry.order_id == order.id)).all()
            assert not any(x.account == 'payment_processing' for x in ledger)
            assert any(x.account == 'restaurant_payable' for x in ledger)


def test_cash_delivery_has_no_service_fee_but_retains_delivery_and_tip():
    with TestClient(app) as client:
        auth = login(client, 'cliente@talaeats.mx', 'Cliente123!')
        row, _ = create(client, auth, 'cash', delivery=True, tip=15)
        assert cents(row['service_fee']) == Decimal('0')
        assert cents(row['payment_processing_fee']) == Decimal('0')
        assert cents(row['delivery_fee']) > 0
        assert cents(row['tip']) == 15
        assert cents(row['total']) == cents(row['subtotal']) - cents(row['discount']) + cents(row['delivery_fee']) + 15
        assert cents(row['driver_earning']) > 0
        assert row['payment_status'] == 'pending'


def test_cash_zero_fee_ignores_restaurant_fixed_fee_and_global_minimum():
    with SessionLocal() as db:
        restaurant = db.get(models.Restaurant, 1)
        restaurant.service_fee_fixed = Decimal('25.00')
        global_min = db.scalar(select(models.SystemSetting).where(models.SystemSetting.key == 'service_fee_min'))
        global_min.value = '35.00'
        db.commit()
    with TestClient(app) as client:
        auth = login(client, 'cliente@talaeats.mx', 'Cliente123!')
        row, _ = create(client, auth, 'cash', delivery=True)
        assert cents(row['service_fee']) == 0
        assert cents(row['platform_revenue']) >= cents(row['platform_commission'])


def test_online_methods_keep_existing_fee_rules(monkeypatch):
    monkeypatch.setattr(settings, 'stripe_enabled', True)
    monkeypatch.setattr(settings, 'stripe_secret_key', 'sk_test_mock')
    monkeypatch.setattr(settings, 'stripe_webhook_secret', 'whsec_mock')
    with TestClient(app) as client:
        auth = login(client, 'cliente@talaeats.mx', 'Cliente123!')
        online, _ = create(client, auth, 'mercadopago')
        stripe, _ = create(client, auth, 'stripe')
        cash, _ = create(client, auth, 'cash')
        assert cents(online['service_fee']) > 0
        assert cents(stripe['service_fee']) > 0
        assert cents(stripe['payment_processing_fee']) > 0
        assert cents(cash['service_fee']) == 0


def test_production_cash_option_explicit_override(monkeypatch):
    with TestClient(app) as client:
        auth = login(client, 'cliente@talaeats.mx', 'Cliente123!')
        # TestClient lifespan runs in development; production policy is toggled
        # only for request validation, without requiring production infrastructure.
        monkeypatch.setattr(settings, 'environment', 'production')
        monkeypatch.setattr(settings, 'require_online_payments', True)
        monkeypatch.setattr(settings, 'cash_checkout_enabled', True)
        methods = client.get('/api/v1/orders/payment-methods')
        assert methods.status_code == 200
        cash = next(x for x in methods.json()['methods'] if x['id'] == 'cash')
        assert cash['enabled'] is True and cash['service_fee_waived'] is True
        payload = {
            'restaurant_id': 1, 'address': 'Tala, Jalisco',
            'payment_method': 'cash', 'order_type': 'pickup',
            'items': [{'menu_item_id': 1, 'quantity': 1}],
        }
        created = client.post('/api/v1/orders', json=payload, headers=auth)
        assert created.status_code == 201, created.text
        assert cents(created.json()['service_fee']) == 0
        payload['payment_method'] = 'wallet'
        denied = client.post('/api/v1/orders', json=payload, headers=auth)
        assert denied.status_code == 400


def test_cash_policy_can_be_switched_off_without_disrupting_old_gate(monkeypatch):
    with TestClient(app) as client:
        auth = login(client, 'cliente@talaeats.mx', 'Cliente123!')
        monkeypatch.setattr(settings, 'environment', 'production')
        monkeypatch.setattr(settings, 'require_online_payments', True)
        monkeypatch.setattr(settings, 'cash_checkout_enabled', False)
        methods = client.get('/api/v1/orders/payment-methods').json()['methods']
        assert next(x for x in methods if x['id'] == 'cash')['enabled'] is False
        resp = client.post('/api/v1/orders', json={'restaurant_id':1,'address':'Tala, Jalisco',
            'payment_method':'cash','order_type':'pickup','items':[{'menu_item_id':1,'quantity':1}]}, headers=auth)
        assert resp.status_code == 400


def test_cash_delivery_collected_only_after_pin_delivery():
    with TestClient(app) as client:
        customer = login(client, 'cliente@talaeats.mx', 'Cliente123!')
        owner = login(client, 'restaurante@talaeats.mx', 'Restaurante123!')
        driver = login(client, 'repartidor@talaeats.mx', 'Repartidor123!')
        client.patch('/api/v1/driver/availability', json={'is_online': True}, headers=driver)
        row, _ = create(client, customer, 'cash', delivery=True)
        oid = row['id']
        for state in ('confirmed', 'preparing', 'ready'):
            response = client.patch(f'/api/v1/owner/orders/{oid}/status', json={'status': state}, headers=owner)
            assert response.status_code == 200, response.text
        wrong = client.post(f'/api/v1/driver/orders/{oid}/complete', headers=driver,
            json={'pin': '0000' if row['delivery_pin'] != '0000' else '9999'})
        assert wrong.status_code in (400, 409)
        with SessionLocal() as db:
            order = db.get(models.Order, oid)
            assert order.payment_status == 'pending'
            assert cents(order.cash_collected) == 0
        for state in ('picked_up', 'on_the_way'):
            response = client.patch(f'/api/v1/driver/orders/{oid}/status', headers=driver, json={'status':state})
            assert response.status_code == 200, response.text
        done = client.post(f'/api/v1/driver/orders/{oid}/complete', headers=driver,
            json={'pin':row['delivery_pin']})
        assert done.status_code == 200, done.text
        assert done.json()['status'] == 'delivered'
        with SessionLocal() as db:
            order = db.get(models.Order, oid)
            assert order.payment_status == 'paid'
            assert cents(order.cash_collected) == cents(order.total)
            assert cents(order.service_fee) == 0
