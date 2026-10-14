"""Business policy v1.5.2: keep old data immutable and all payment rails additive."""
from decimal import Decimal
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app
from app.monetization import calculate_order_economics, effective_delivery_fee, commercial_value


def d(v):
    return Decimal(str(v))


@pytest.fixture(autouse=True)
def use_policy(monkeypatch):
    monkeypatch.setattr(settings, 'commercial_pricing_v152_enabled', True)


def login(c):
    resp = c.post('/api/v1/auth/login', json={'email': 'cliente@talaeats.mx', 'password': 'Cliente123!'})
    assert resp.status_code == 200, resp.text
    return {'Authorization': 'Bearer ' + resp.json()['access_token']}


def order(c, auth, method='cash', *, order_type='delivery', tip=10, distance=1.0, coupon=None):
    payload = {
        'restaurant_id': 1, 'address': 'Tala, Jalisco', 'order_type': order_type,
        'payment_method': method, 'distance_km': distance, 'tip': tip,
        'client_reference': 'pricing152-' + uuid4().hex,
        'items': [{'menu_item_id': 1, 'quantity': 1}],
    }
    if coupon: payload['coupon_code'] = coupon
    resp = c.post('/api/v1/orders', headers=auth, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json(), payload


def disable_plus():
    with SessionLocal() as db:
        account = db.scalar(select(models.LoyaltyAccount).where(models.LoyaltyAccount.user_id == 3))
        assert account is not None
        account.plus_member = False
        db.commit()


def check_split(row, merchant_managed=False):
    total = d(row['total'])
    tip = d(row['tip'])
    commission = d(row['platform_commission'])
    fee = d(row['service_fee'])
    merchandise = d(row['subtotal']) - d(row['discount'])
    assert commission == (merchandise * d('0.15')).quantize(d('0.01'))
    assert fee == (merchandise * d('0.07')).quantize(d('0.01'))
    assert total == merchandise + fee + d(row['delivery_fee']) + tip
    assert d(row['restaurant_payout']) + d(row['driver_earning']) + (tip if row['order_type']=='delivery' and not merchant_managed else 0) + d(row['platform_revenue']) == total
    assert d(row['contribution_margin']) == d(row['platform_revenue']) - d(row['payment_processing_fee']) - d(row['promotion_subsidy'])


def test_cash_service_seven_percent_and_fixed_base_delivery_and_driver():
    disable_plus()
    with TestClient(app) as c:
        a = login(c)
        row, _ = order(c, a, method='cash', tip=10)
        check_split(row)
        assert d(row['delivery_fee']) == d('39.00')
        assert d(row['driver_earning']) == d('32.00')
        assert d(row['payment_processing_fee']) == 0
        assert row['payment_status'] == 'pending'
        assert d(row['restaurant_payout']) == d(row['subtotal']) - d(row['platform_commission'])
        with SessionLocal() as db:
            entries = db.scalars(select(models.FinancialLedgerEntry).where(models.FinancialLedgerEntry.order_id == row['id'])).all()
            by_account = {x.account: x for x in entries}
            assert d(by_account['driver_payable'].amount) == d('42.00')
            assert d(by_account['restaurant_payable'].amount) + d(by_account['driver_payable'].amount) + d(by_account['platform_revenue'].amount) == d(row['total'])


def test_mercado_pago_and_stripe_same_service_rate_but_processing_estimate_separate(monkeypatch):
    disable_plus()
    monkeypatch.setattr(settings, 'stripe_enabled', True)
    monkeypatch.setattr(settings, 'stripe_secret_key', 'sk_test_placeholder')
    monkeypatch.setattr(settings, 'stripe_webhook_secret', 'whsec_placeholder')
    with TestClient(app) as c:
        a = login(c)
        cash, _ = order(c, a, 'cash', tip=0)
        mp, _ = order(c, a, 'mercadopago', tip=0)
        stripe, _ = order(c, a, 'stripe', tip=0)
        for row in (cash, mp, stripe):
            check_split(row)
            assert d(row['service_fee']) == d(cash['service_fee'])
            assert d(row['total']) == d(cash['total'])
            assert d(row['driver_earning']) == d('32.00')
        assert d(mp['payment_processing_fee']) > 0
        assert d(stripe['payment_processing_fee']) > 0
        assert d(cash['payment_processing_fee']) == 0


def test_tip_has_zero_commission_while_driver_gets_full_tip():
    disable_plus()
    with TestClient(app) as c:
        a = login(c)
        zero, _ = order(c, a, 'cash', tip=0)
        tipped, _ = order(c, a, 'cash', tip=25)
        assert d(zero['service_fee']) == d(tipped['service_fee'])
        assert d(zero['platform_commission']) == d(tipped['platform_commission'])
        assert d(zero['platform_revenue']) == d(tipped['platform_revenue'])
        assert d(tipped['total']) - d(zero['total']) == 25
        with SessionLocal() as db:
            line = db.scalar(select(models.FinancialLedgerEntry).where(models.FinancialLedgerEntry.order_id == tipped['id'], models.FinancialLedgerEntry.account == 'driver_payable'))
            assert d(line.amount) == d('57.00')


def test_pickup_has_no_delivery_driver_pay_and_tip_goes_to_restaurant():
    with TestClient(app) as c:
        a = login(c)
        row, _ = order(c, a, 'cash', order_type='pickup', tip=11)
        check_split(row)
        assert d(row['delivery_fee']) == 0
        assert d(row['driver_earning']) == 0
        assert d(row['restaurant_payout']) == d(row['subtotal']) - d(row['platform_commission']) + 11


def test_plus_discount_keeps_legacy_benefit_and_margin_is_algebraically_correct():
    with TestClient(app) as c:
        a=login(c)
        row,_=order(c,a,'cash',tip=5)
        check_split(row)
        assert d(row['delivery_fee']) == d('19.50')  # 50% PLUS discount on 39 base
        assert d(row['driver_earning']) == d('32')
        assert d(row['platform_revenue']) == d(row['platform_commission']) + d(row['service_fee']) + d(row['delivery_fee']) - d(row['driver_earning'])


def test_long_distance_uses_existing_surcharge_when_higher_than_base():
    with SessionLocal() as db:
        rest=db.get(models.Restaurant, 1)
        assert effective_delivery_fee(db, rest, 8) > 39
        assert effective_delivery_fee(db, rest, 0) == 39


def test_fee_settings_invalid_values_fall_back_to_policy_defaults():
    with SessionLocal() as db:
        db.add(models.SystemSetting(key='commercial_v152.service_fee_rate', value='NaN', value_type='decimal'))
        db.commit()
        assert commercial_value(db, 'commercial_v152.service_fee_rate', d('0.25')) == d('0.07')
        row=db.scalar(select(models.SystemSetting).where(models.SystemSetting.key=='commercial_v152.service_fee_rate'))
        row.value='999999';db.commit()
        assert commercial_value(db, 'commercial_v152.service_fee_rate', d('0.25')) == d('0.07')


def test_legacy_compatibility_switch_preserves_cash_fee_waiver(monkeypatch):
    monkeypatch.setattr(settings, 'commercial_pricing_v152_enabled', False)
    with TestClient(app) as c:
        a=login(c)
        row,_=order(c,a,'cash')
        assert d(row['service_fee']) == 0
        methods=c.get('/api/v1/orders/payment-methods').json()
        assert next(m for m in methods['methods'] if m['id']=='cash')['service_fee_waived'] is True


def test_payment_methods_endpoint_clearly_announces_cash_charges():
    with TestClient(app) as c:
        response=c.get('/api/v1/orders/payment-methods')
        assert response.status_code==200
        j=response.json()
        assert j['commercial_pricing_version']=='1.5.2'
        assert next(m for m in j['methods'] if m['id']=='cash')['service_fee_waived'] is False


def test_idempotent_checkout_keeps_economic_snapshot_when_fee_policy_changes(monkeypatch):
    with TestClient(app) as c:
        a=login(c)
        row,payload=order(c,a,'cash',tip=9)
        monkeypatch.setattr(settings, 'commercial_pricing_v152_enabled', False)
        resp=c.post('/api/v1/orders',headers=a,json=payload)
        assert resp.status_code==201,resp.text
        assert resp.json()['id']==row['id']
        assert resp.json()['total']==row['total']
        assert resp.json()['service_fee']==row['service_fee']
