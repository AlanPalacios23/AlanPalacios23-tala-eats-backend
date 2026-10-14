from decimal import Decimal

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app


def login(client, email, password):
    response = client.post('/api/v1/auth/login', json={'email': email, 'password': password})
    assert response.status_code == 200, response.text
    return {'Authorization': f"Bearer {response.json()['access_token']}"}


def test_v1_merchant_managed_delivery_end_to_end():
    previous = settings.merchant_managed_delivery
    settings.merchant_managed_delivery = True
    try:
        with TestClient(app) as client:
            customer = login(client, 'cliente@talaeats.mx', 'Cliente123!')
            owner = login(client, 'restaurante@talaeats.mx', 'Restaurante123!')
            restaurant = client.get('/api/v1/restaurants/1').json()
            item = restaurant['menu_items'][0]

            created = client.post('/api/v1/orders', headers=customer, json={
                'restaurant_id': 1,
                'address': 'Centro, Tala, Jalisco',
                'payment_method': 'cash',
                'tip': 15,
                'order_type': 'delivery',
                'distance_km': 1.0,
                'items': [{'menu_item_id': item['id'], 'quantity': 1}],
            })
            assert created.status_code == 201, created.text
            order = created.json()
            assert Decimal(str(order['driver_earning'])) == Decimal('0')
            assert Decimal(str(order['restaurant_payout'])) > Decimal('0')

            for status in ['confirmed', 'preparing', 'ready']:
                response = client.patch(f"/api/v1/owner/orders/{order['id']}/status", headers=owner, json={'status': status})
                assert response.status_code == 200, response.text

            ready = client.get(f"/api/v1/orders/{order['id']}", headers=customer).json()
            assert ready['status'] == 'ready'
            assert ready['driver_id'] is None

            route = client.patch(f"/api/v1/owner/orders/{order['id']}/status", headers=owner, json={'status': 'on_the_way'})
            assert route.status_code == 200, route.text
            assert route.json()['status'] == 'on_the_way'
            assert route.json()['driver_id'] is None

            completed = client.post(
                f"/api/v1/owner/orders/{order['id']}/complete",
                headers=owner,
                json={'pin': order['delivery_pin'], 'photo_url': '', 'lat': None, 'lng': None},
            )
            assert completed.status_code == 200, completed.text
            assert completed.json()['status'] == 'delivered'
            assert completed.json()['driver_id'] is None
    finally:
        settings.merchant_managed_delivery = previous


def test_v1_production_rejects_offline_payment_method():
    previous_environment = settings.environment
    previous_require_online = settings.require_online_payments
    previous_merchant = settings.merchant_managed_delivery
    try:
        with TestClient(app) as client:
            customer = login(client, 'cliente@talaeats.mx', 'Cliente123!')
            restaurant = client.get('/api/v1/restaurants/1').json()
            item = restaurant['menu_items'][0]
            settings.environment = 'production'
            settings.require_online_payments = True
            settings.merchant_managed_delivery = True
            response = client.post('/api/v1/orders', headers=customer, json={
                'restaurant_id': 1,
                'address': 'Centro, Tala, Jalisco',
                'payment_method': 'cash',
                'order_type': 'delivery',
                'distance_km': 1.0,
                'items': [{'menu_item_id': item['id'], 'quantity': 1}],
            })
            assert response.status_code == 400, response.text
            assert 'Mercado Pago' in response.json()['detail']
    finally:
        settings.environment = previous_environment
        settings.require_online_payments = previous_require_online
        settings.merchant_managed_delivery = previous_merchant


def test_v1_driver_api_is_disabled_when_commerce_delivers():
    previous = settings.merchant_managed_delivery
    settings.merchant_managed_delivery = True
    try:
        with TestClient(app) as client:
            response = client.get('/api/v1/driver/profile')
            assert response.status_code == 410, response.text
            assert 'no está activo' in response.json()['detail']
    finally:
        settings.merchant_managed_delivery = previous
