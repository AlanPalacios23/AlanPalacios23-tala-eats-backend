"""Regresiones monetarias v1.6.2: pago de repartidor en kilómetros.

No utiliza Stripe real ni modifica producción: fixtures SQLite aisladas.
"""
from decimal import Decimal
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app
from app.monetization import calculate_order_economics, effective_delivery_fee

D = lambda v: Decimal(str(v))

@pytest.fixture(autouse=True)
def active_pricing(monkeypatch):
    monkeypatch.setattr(settings, 'commercial_pricing_v152_enabled', True)
    monkeypatch.setattr(settings, 'commercial_pricing_v162_enabled', True)

@pytest.mark.parametrize('km,fee,pay', [
    (0,'35.00','32.00'), (1,'35.00','32.00'), (2,'35.00','32.00'),
    (2.25,'36.25','33.00'), (3,'40.00','36.00'),
    (5,'50.00','44.00'), (7,'60.00','52.00'),
    (8,'65.00','56.00'), (9,'70.00','60.00'),
])
@pytest.mark.parametrize('method', ['cash','stripe'])
def test_driver_pay_per_distance_calculated_by_server(km, fee, pay, method):
    with SessionLocal() as db:
        restaurant = db.get(models.Restaurant, 1)
        delivery = effective_delivery_fee(db,restaurant,km)
        assert delivery == D(fee)
        quote = calculate_order_economics(db,restaurant,D('1000'),D('0'),delivery,D('10'),method,distance_km=km)
        assert quote['driver_earning'] == D(pay)
        assert quote['platform_commission'] == D('150')
        assert quote['service_fee'] == D('25')
        assert quote['total'] == D('1000') + D(fee) + D('25') + D('10')
        assert quote['restaurant_payout'] + quote['driver_earning'] + quote['platform_revenue'] + D('10') == quote['total']
        assert quote['contribution_margin'] == quote['platform_revenue'] - quote['payment_processing_fee']

@pytest.mark.parametrize('mode,managed,expected', [
    ('pickup',False,'0'), ('delivery',True,'0'), ('delivery',False,'60.00')
])
def test_pickup_merchant_driver_separate(mode,managed,expected):
    with SessionLocal() as db:
        restaurant=db.get(models.Restaurant,1)
        shipping = D('0') if mode=='pickup' else effective_delivery_fee(db,restaurant,9)
        result=calculate_order_economics(db,restaurant,D('200'),D('0'),shipping,D('5'),'cash',merchant_managed_delivery=managed,order_type=mode,distance_km=9)
        assert result['driver_earning']==D(expected)


def test_plus_subsidy_does_not_cut_driver_pay():
    with SessionLocal() as db:
        restaurant=db.get(models.Restaurant,1)
        gross=effective_delivery_fee(db,restaurant,9)
        discounted=gross*D('0.5')
        quote=calculate_order_economics(db,restaurant,D('200'),D('0'),discounted,D('0'),'cash',distance_km=9)
        assert quote['driver_earning']==D('60.00')
        assert quote['total']==D('200')+D('14')+discounted
        # Este margen neto de envío es negativo; controlarlo en monitoreo del piloto.
        assert discounted-quote['driver_earning']<0


def test_config_optout_preserves_old_driver_pay(monkeypatch):
    monkeypatch.setattr(settings,'commercial_pricing_v162_enabled',False)
    with SessionLocal() as db:
        restaurant=db.get(models.Restaurant,1)
        fee=effective_delivery_fee(db,restaurant,1)
        quote=calculate_order_economics(db,restaurant,D('200'),D('0'),fee,D('0'),'cash',distance_km=1)
        assert fee==D('39')
        assert quote['driver_earning']==D('32')


def test_invalid_rate_fails_closed():
    with SessionLocal() as db:
        restaurant=db.get(models.Restaurant,1)
        db.add(models.SystemSetting(key='commercial_v162.driver_additional_per_km',value='NaN',value_type='decimal'))
        db.commit()
        quote=calculate_order_economics(db,restaurant,D('300'),D('0'),D('65'),D('0'),'cash',distance_km=8)
        assert quote['driver_earning']==D('56')


def test_checkout_snapshot_and_ledger_with_real_order():
    # Ejecuta la API local en modo test, sin modificar servidor ni disparar pagos.
    with TestClient(app) as client:
        login=client.post('/api/v1/auth/login',json={'email':'cliente@talaeats.mx','password':'Cliente123!'})
        assert login.status_code==200,login.text
        auth={'Authorization':'Bearer '+login.json()['access_token']}
        with SessionLocal() as db:
            account=db.scalar(select(models.LoyaltyAccount).where(models.LoyaltyAccount.user_id==3))
            account.plus_member=False
            restaurant=db.get(models.Restaurant,1)
            restaurant.delivery_radius_km=15.0
            db.commit()
        payload={
           'restaurant_id':1,'address':'Tala, Jalisco','order_type':'delivery','payment_method':'cash',
           'distance_km':8,'tip':10,
           'client_reference':'driver-fair-'+uuid4().hex,
           'items':[{'menu_item_id':1,'quantity':1}],
        }
        result=client.post('/api/v1/orders',headers=auth,json=payload)
        assert result.status_code==201,result.text
        order=result.json()
        assert D(order['delivery_fee'])==D('65')
        assert D(order['driver_earning'])==D('56')
        with SessionLocal() as db:
            db_order=db.get(models.Order,order['id'])
            assert D(db_order.distance_km)==D('8')
            assert D(db_order.driver_earning)==D('56')
            entry=db.scalar(select(models.FinancialLedgerEntry).where(
                models.FinancialLedgerEntry.order_id==order['id'],
                models.FinancialLedgerEntry.account=='driver_payable'))
            assert entry is not None
            assert D(entry.amount)==D('66') # $56 + $10 propina íntegra
        # Pedido existente idempotente mantiene el pago base aunque cambie el flag.
        settings.commercial_pricing_v162_enabled=False
        again=client.post('/api/v1/orders',headers=auth,json=payload)
        assert again.status_code==201
        assert again.json()['id']==order['id']
        assert D(again.json()['driver_earning'])==D('56')
