from fastapi.testclient import TestClient

from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app


def login(client, email, password):
    response = client.post('/api/v1/auth/login', json={'email': email, 'password': password})
    assert response.status_code == 200, response.text
    return {'Authorization': f"Bearer {response.json()['access_token']}"}


def _new_order(client, customer, ref):
    restaurant = client.get('/api/v1/restaurants/1').json()
    item = restaurant['menu_items'][0]
    response = client.post('/api/v1/orders', headers=customer, json={
        'restaurant_id': 1,
        'address': 'Centro, Tala, Jalisco',
        'payment_method': 'cash',
        'order_type': 'delivery',
        'distance_km': 1.0,
        'client_reference': ref,
        'items': [{'menu_item_id': item['id'], 'quantity': 1}],
    })
    assert response.status_code == 201, response.text
    return response.json()


def _advance_restaurant(client, owner, order_id):
    result = None
    for status in ['confirmed', 'preparing', 'ready']:
        result = client.patch(
            f'/api/v1/owner/orders/{order_id}/status',
            headers=owner,
            json={'status': status},
        )
        assert result.status_code == 200, result.text
    return result.json()


def test_customer_restaurant_driver_share_one_order_lifecycle():
    previous = settings.merchant_managed_delivery
    settings.merchant_managed_delivery = False
    try:
        with TestClient(app) as client:
            customer = login(client, 'cliente@talaeats.mx', 'Cliente123!')
            owner = login(client, 'restaurante@talaeats.mx', 'Restaurante123!')
            driver = login(client, 'repartidor@talaeats.mx', 'Repartidor123!')

            # Clean any prior active test state and force a known availability state.
            with SessionLocal() as db:
                driver_user = db.query(models.User).filter(models.User.email == 'repartidor@talaeats.mx').one()
                for order in db.query(models.Order).filter(
                    models.Order.driver_id == driver_user.id,
                    models.Order.status.in_(['assigned', 'picked_up', 'on_the_way']),
                ):
                    order.status = 'cancelled'
                    order.driver_id = None
                profile = db.query(models.DriverProfile).filter(models.DriverProfile.user_id == driver_user.id).one()
                profile.is_online = False
                db.commit()

            availability = client.patch('/api/v1/driver/availability', headers=driver, json={'is_online': True})
            assert availability.status_code == 200, availability.text
            assert availability.json()['is_online'] is True

            first = _new_order(client, customer, 'pytest-three-apps-first')
            first_ready = _advance_restaurant(client, owner, first['id'])
            assert first_ready['status'] == 'assigned'
            assert first_ready['driver_id'] is not None

            dashboard = client.get('/api/v1/driver/dashboard', headers=driver)
            assert dashboard.status_code == 200, dashboard.text
            assert dashboard.json()['active']['id'] == first['id']
            assert dashboard.json()['active']['code'].startswith('TE-')

            # A second ready order must not be double-assigned to the same active driver.
            second = _new_order(client, customer, 'pytest-three-apps-second')
            second_ready = _advance_restaurant(client, owner, second['id'])
            assert second_ready['status'] == 'ready'
            assert second_ready['driver_id'] is None

            invalid_skip = client.patch(
                f"/api/v1/driver/orders/{first['id']}/status",
                headers=driver,
                json={'status': 'on_the_way'},
            )
            assert invalid_skip.status_code == 409, invalid_skip.text

            picked = client.patch(
                f"/api/v1/driver/orders/{first['id']}/status",
                headers=driver,
                json={'status': 'picked_up'},
            )
            assert picked.status_code == 200, picked.text
            route = client.patch(
                f"/api/v1/driver/orders/{first['id']}/status",
                headers=driver,
                json={'status': 'on_the_way'},
            )
            assert route.status_code == 200, route.text

            cannot_disconnect = client.patch('/api/v1/driver/availability', headers=driver, json={'is_online': False})
            assert cannot_disconnect.status_code == 409, cannot_disconnect.text

            completed = client.post(
                f"/api/v1/driver/orders/{first['id']}/complete",
                headers=driver,
                json={'pin': first['delivery_pin'], 'photo_url': '', 'lat': 20.6534, 'lng': -103.7040},
            )
            assert completed.status_code == 200, completed.text
            assert completed.json()['status'] == 'delivered'

            # Completing the first delivery automatically pulls the oldest waiting ready order.
            second_after = client.get(f"/api/v1/orders/{second['id']}", headers=customer)
            assert second_after.status_code == 200, second_after.text
            assert second_after.json()['status'] == 'assigned'
            assert second_after.json()['driver_id'] == first_ready['driver_id']

            customer_view = client.get(f"/api/v1/orders/{first['id']}", headers=customer).json()
            owner_view = client.get('/api/v1/owner/orders?active_only=false&limit=200', headers=owner).json()
            assert customer_view['status'] == 'delivered'
            assert any(order['id'] == first['id'] and order['status'] == 'delivered' for order in owner_view)

            ready = client.get('/api/v1/ready').json()
            assert ready['driver_portal_enabled'] is True
            assert ready['product_scope'] == 'customer-restaurant-driver-admin'
    finally:
        settings.merchant_managed_delivery = previous



def test_production_mobile_clients_receive_real_bearer_token():
    previous = settings.environment
    with TestClient(app) as client:
        settings.environment = "production"
        try:
            for client_kind, email, password in [
                ("mobile", "cliente@talaeats.mx", "Cliente123!"),
                ("restaurant-mobile", "restaurante@talaeats.mx", "Restaurante123!"),
                ("driver-mobile", "repartidor@talaeats.mx", "Repartidor123!"),
            ]:
                response = client.post(
                    "/api/v1/auth/login",
                    headers={"X-TalaEats-Client": client_kind},
                    json={"email": email, "password": password, "otp": ""},
                )
                assert response.status_code == 200, response.text
                token = response.json()["access_token"]
                assert token and token != "cookie"
        finally:
            settings.environment = previous
