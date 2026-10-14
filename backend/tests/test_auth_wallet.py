from fastapi.testclient import TestClient

from app.main import app


def auth_header(response):
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def login(client, email, password):
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return auth_header(response)


def test_google_registration_creates_wallet(monkeypatch):
    import sys
    import types
    from app.config import settings

    settings.google_client_id = "123456789-test.apps.googleusercontent.com"

    google = types.ModuleType("google")
    auth = types.ModuleType("google.auth")
    transport = types.ModuleType("google.auth.transport")
    requests_mod = types.ModuleType("google.auth.transport.requests")
    oauth2 = types.ModuleType("google.oauth2")
    id_token_mod = types.ModuleType("google.oauth2.id_token")

    class Request:
        pass

    requests_mod.Request = Request
    id_token_mod.verify_oauth2_token = lambda credential, request, audience: {
        "sub": "google-user-v31-001",
        "email": "google.v31@example.com",
        "email_verified": True,
        "name": "Google V31",
        "picture": "https://example.com/avatar.png",
    }
    google.auth = auth
    google.oauth2 = oauth2
    auth.transport = transport
    transport.requests = requests_mod
    oauth2.id_token = id_token_mod
    monkeypatch.setitem(sys.modules, "google", google)
    monkeypatch.setitem(sys.modules, "google.auth", auth)
    monkeypatch.setitem(sys.modules, "google.auth.transport", transport)
    monkeypatch.setitem(sys.modules, "google.auth.transport.requests", requests_mod)
    monkeypatch.setitem(sys.modules, "google.oauth2", oauth2)
    monkeypatch.setitem(sys.modules, "google.oauth2.id_token", id_token_mod)

    with TestClient(app) as client:
        response = client.post("/api/v1/auth/google", json={"credential": "x" * 40})
        assert response.status_code == 200, response.text
        assert response.json()["user"]["auth_provider"] == "google"
        wallet = client.get("/api/v1/platform/wallet")
        assert wallet.status_code == 200, wallet.text
        data = wallet.json()
        assert float(data["balance"]) == 0
        assert data["referral_code"].startswith("TALA")


def test_wallet_ledger_charge_and_cancel_refund():
    with TestClient(app) as client:
        email = "wallet.v31@example.com"
        registered = client.post("/api/v1/auth/register", json={"name": "Wallet V31", "email": email, "password": "Wallet123!"})
        assert registered.status_code in {201, 409}, registered.text
        customer = login(client, email, "Wallet123!")
        user_id = client.get("/api/v1/auth/me", headers=customer).json()["id"]

        admin = login(client, "admin@talaeats.mx", "Admin123!")
        adjusted = client.post(
            f"/api/v1/admin/wallet/{user_id}/adjust",
            headers=admin,
            json={"amount": 500, "reason": "Saldo de prueba automatizada"},
        )
        assert adjusted.status_code == 200, adjusted.text
        starting = float(adjusted.json()["balance"])
        assert starting >= 500

        restaurant = client.get("/api/v1/restaurants/1").json()
        item = restaurant["menu_items"][0]
        created = client.post(
            "/api/v1/orders",
            headers=customer,
            json={
                "restaurant_id": 1,
                "address": "Centro, Tala, Jalisco",
                "payment_method": "wallet",
                "distance_km": 1.0,
                "items": [{"menu_item_id": item["id"], "quantity": 1}],
            },
        )
        assert created.status_code == 201, created.text
        order = created.json()
        assert order["payment_status"] == "paid"

        after_charge = client.get("/api/v1/platform/wallet", headers=customer).json()
        assert float(after_charge["balance"]) < starting
        kinds = [row["kind"] for row in after_charge["transactions"]]
        assert "order_payment" in kinds

        cancelled = client.post(f"/api/v1/orders/{order['id']}/cancel", headers=customer)
        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()["payment_status"] == "refunded"

        after_refund = client.get("/api/v1/platform/wallet", headers=customer).json()
        assert round(float(after_refund["balance"]), 2) == round(starting, 2)
        kinds = [row["kind"] for row in after_refund["transactions"]]
        assert "order_refund" in kinds


def test_production_mobile_client_receives_bearer_token():
    from app.config import settings
    with TestClient(app) as client:
        previous = settings.environment
        settings.environment = "production"
        try:
            web = client.post("/api/v1/auth/login", json={"email": "cliente@talaeats.mx", "password": "Cliente123!"})
            assert web.status_code == 200, web.text
            assert web.json()["access_token"] == "cookie"

            mobile = client.post(
                "/api/v1/auth/login",
                headers={"X-TalaEats-Client": "mobile"},
                json={"email": "cliente@talaeats.mx", "password": "Cliente123!"},
            )
            assert mobile.status_code == 200, mobile.text
            token = mobile.json()["access_token"]
            assert token and token != "cookie" and token.count(".") == 2
            me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
            assert me.status_code == 200, me.text
            assert me.json()["email"] == "cliente@talaeats.mx"
        finally:
            settings.environment = previous
