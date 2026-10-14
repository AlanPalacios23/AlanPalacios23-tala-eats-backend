"""v1.6.2 fee cap, kilometre tiers, legacy and money conservation."""
from decimal import Decimal
from fastapi.testclient import TestClient
from app.config import settings
from app.db import SessionLocal
from app.main import app
from app import models
from app.monetization import effective_delivery_fee, calculate_order_economics
import pytest

@pytest.fixture(autouse=True)
def policy(monkeypatch):
    monkeypatch.setattr(settings, 'commercial_pricing_v152_enabled', True)
    monkeypatch.setattr(settings, 'commercial_pricing_v162_enabled', True)

@pytest.mark.parametrize('km,expected', [
    (0, '35.00'), (1, '35.00'), (2, '35.00'), (2.1, '35.50'),
    (2.5, '37.50'), (3, '40.00'), (8, '65.00')])
def test_tiered_delivery(km, expected):
    with SessionLocal() as db:
        rest=db.get(models.Restaurant, 1)
        assert effective_delivery_fee(db, rest, km) == Decimal(expected)

@pytest.mark.parametrize('amount,expected_fee', [
    ('0', '0.00'), ('100', '7.00'), ('200', '14.00'),
    ('357.14', '25.00'), ('500', '25.00'), ('1000', '25.00'),
])
@pytest.mark.parametrize('method', ['cash', 'stripe', 'mercadopago'])
def test_seven_percent_capped_and_snapshot_total(method, amount, expected_fee):
    with SessionLocal() as db:
        rest=db.get(models.Restaurant, 1)
        eco=calculate_order_economics(db, rest, Decimal(amount), Decimal('0'), Decimal('35'), Decimal('0'), method)
        assert eco['service_fee'] == Decimal(expected_fee)
        assert eco['platform_commission'] == (Decimal(amount) * Decimal('0.15')).quantize(Decimal('0.01'))
        assert eco['total'] == Decimal(amount) + Decimal(expected_fee) + Decimal('35')
        assert eco['restaurant_payout'] + eco['driver_earning'] + eco['platform_revenue'] == eco['total']

def test_payment_methods_metadata_and_pickup_zero_delivery():
    with TestClient(app) as c:
        res=c.get('/api/v1/orders/payment-methods');assert res.status_code==200
        data=res.json()
        assert data['commercial_pricing_version']=='1.6.2'
        assert data['service_fee_cap']=='25.00'
        assert data['delivery_base_fee']=='35.00'
        assert data['delivery_included_km']=='2.00'
        assert data['delivery_additional_per_km']=='5.00'
        assert next(m for m in data['methods'] if m['id']=='cash')['service_fee_waived'] is False

def test_optout_returns_old_prices(monkeypatch):
    monkeypatch.setattr(settings, 'commercial_pricing_v162_enabled', False)
    with SessionLocal() as db:
        rest=db.get(models.Restaurant,1)
        assert effective_delivery_fee(db,rest,0)==Decimal('39.00')
        eco=calculate_order_economics(db,rest,Decimal('1000'),Decimal('0'),Decimal('39'),Decimal('0'),'cash')
        assert eco['service_fee']==Decimal('70.00')
    with TestClient(app) as c:
        assert c.get('/api/v1/orders/payment-methods').json()['commercial_pricing_version']=='1.5.2'

def test_plus_and_driver_minimum_unchanged():
    with SessionLocal() as db:
        rest=db.get(models.Restaurant,1)
        economics=calculate_order_economics(db, rest, Decimal('200'), Decimal('0'), Decimal('17.50'), Decimal('0'), 'cash')
        assert economics['driver_earning']==Decimal('32.00')
        assert economics['service_fee']==Decimal('14.00')
        # Plus benefit may subsidize the trip; flag for margin monitoring.
        assert economics['total']==Decimal('231.50')
