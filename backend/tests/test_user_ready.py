import hashlib

from fastapi.testclient import TestClient

from app.main import app
from app.db import SessionLocal
from app import models


def login(client, email, password):
    response = client.post('/api/v1/auth/login', json={'email': email, 'password': password})
    assert response.status_code == 200, response.text
    return {'Authorization': f"Bearer {response.json()['access_token']}"}


def test_profile_addresses_and_bootstrap():
    with TestClient(app) as client:
        headers = login(client, 'cliente@talaeats.mx', 'Cliente123!')
        updated = client.patch('/api/v1/auth/me', headers=headers, json={'phone': '3312345678'})
        assert updated.status_code == 200, updated.text
        assert updated.json()['phone'] == '3312345678'

        created = client.post('/api/v1/platform/addresses', headers=headers, json={
            'label': 'Casa V5', 'address': 'Centro, Tala, Jalisco', 'lat': 20.6534, 'lng': -103.7040, 'is_default': True,
        })
        assert created.status_code == 201, created.text
        address_id = created.json()['id']
        patched = client.patch(f'/api/v1/platform/addresses/{address_id}', headers=headers, json={'label': 'Casa principal'})
        assert patched.status_code == 200, patched.text
        assert patched.json()['label'] == 'Casa principal'

        bootstrap = client.get('/api/v1/platform/bootstrap', headers=headers)
        assert bootstrap.status_code == 200, bootstrap.text
        assert bootstrap.json()['user']['email'] == 'cliente@talaeats.mx'
        assert 'wallet' in bootstrap.json()

        deleted = client.delete(f'/api/v1/platform/addresses/{address_id}', headers=headers)
        assert deleted.status_code == 204, deleted.text


def test_order_idempotency_reference():
    with TestClient(app) as client:
        headers = login(client, 'cliente@talaeats.mx', 'Cliente123!')
        restaurant = client.get('/api/v1/restaurants/1').json()
        item = restaurant['menu_items'][0]
        payload = {
            'restaurant_id': 1,
            'address': 'Centro, Tala, Jalisco',
            'payment_method': 'cash',
            'distance_km': 1.0,
            'client_reference': 'pytest-user-ready-same-order',
            'items': [{'menu_item_id': item['id'], 'quantity': 1}],
        }
        first = client.post('/api/v1/orders', headers=headers, json=payload)
        assert first.status_code == 201, first.text
        second = client.post('/api/v1/orders', headers=headers, json=payload)
        assert second.status_code == 201, second.text
        assert first.json()['id'] == second.json()['id']


def test_password_reset_token_is_one_time():
    with TestClient(app) as client:
        email = 'reset.v5@example.com'
        registered = client.post('/api/v1/auth/register', json={'name': 'Reset V5', 'email': email, 'password': 'Antes123!'})
        assert registered.status_code in {201, 409}, registered.text
        forgot = client.post('/api/v1/auth/password/forgot', json={'email': email})
        assert forgot.status_code == 202, forgot.text

        # The API stores only a hash. Tests replace it with a known token hash; production users receive the raw token by email.
        raw = 'known-test-reset-token-' + ('x' * 24)
        with SessionLocal() as db:
            row = db.query(models.PasswordResetToken).join(models.User, models.User.id == models.PasswordResetToken.user_id).filter(models.User.email == email).order_by(models.PasswordResetToken.id.desc()).first()
            assert row is not None
            row.token_hash = hashlib.sha256(raw.encode()).hexdigest()
            db.commit()

        reset = client.post('/api/v1/auth/password/reset', json={'token': raw, 'password': 'Despues123!'})
        assert reset.status_code == 200, reset.text
        reused = client.post('/api/v1/auth/password/reset', json={'token': raw, 'password': 'Otra12345!'})
        assert reused.status_code == 400, reused.text
        headers = login(client, email, 'Despues123!')
        assert headers['Authorization'].startswith('Bearer ')
