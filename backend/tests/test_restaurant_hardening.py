from fastapi.testclient import TestClient
from app.main import app


def login(client, email, password):
    response = client.post('/api/v1/auth/login', json={'email': email, 'password': password})
    assert response.status_code == 200, response.text
    return {'Authorization': f"Bearer {response.json()['access_token']}"}


def test_owner_orders_supports_limit_and_active_filter():
    with TestClient(app) as client:
        headers = login(client, 'restaurante@talaeats.mx', 'Restaurante123!')
        limited = client.get('/api/v1/owner/orders?limit=2', headers=headers)
        assert limited.status_code == 200, limited.text
        assert len(limited.json()) <= 2

        active = client.get('/api/v1/owner/orders?active_only=true&limit=100', headers=headers)
        assert active.status_code == 200, active.text
        assert all(row['status'] not in {'delivered', 'cancelled'} for row in active.json())


def test_owner_analytics_is_database_aggregated_contract():
    with TestClient(app) as client:
        headers = login(client, 'restaurante@talaeats.mx', 'Restaurante123!')
        response = client.get('/api/v1/owner/analytics', headers=headers)
        assert response.status_code == 200, response.text
        body = response.json()
        for key in {'orders', 'delivered', 'gross_sales', 'avg_ticket', 'inventory_low'}:
            assert key in body
        assert body['orders'] >= body['delivered'] >= 0


def test_request_id_and_rate_limit_headers_are_exposed():
    with TestClient(app) as client:
        response = client.get('/api/v1/restaurants', headers={'X-Request-ID': 'pytest-restaurant-hardening'})
        assert response.status_code == 200, response.text
        assert response.headers.get('x-request-id') == 'pytest-restaurant-hardening'
        assert int(response.headers.get('x-ratelimit-limit', '0')) > 0
