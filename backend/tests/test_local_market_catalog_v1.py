"""Local commerce market filters: SQLite isolation, permissions and cache keys."""
from fastapi.testclient import TestClient

from app.main import app


def login(client, email, password):
    res = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def test_legacy_catalog_unchanged_and_market_filter_before_pagination():
    with TestClient(app) as client:
        original = client.get("/api/v1/restaurants")
        assert original.status_code == 200, original.text
        assert len(original.json()) == 4
        ameca_id = original.json()[0]["id"]

        admin = login(client, "admin@talaeats.mx", "Admin123!")
        assigned = client.patch(
            f"/api/v1/operations/admin/restaurants/{ameca_id}/market",
            headers=admin, json={"market_code": "AMECA-JAL"},
        )
        assert assigned.status_code == 200, assigned.text
        assert assigned.json()["market_code"] == "AMECA-JAL"

        # Backward compatible unfiltered discovery.
        assert len(client.get("/api/v1/restaurants").json()) == 4
        tala = client.get("/api/v1/restaurants", params={"market_code": "TALA-JAL"}).json()
        ameca = client.get("/api/v1/restaurants", params={"market_code": "ameca-jal"}).json()
        assert len(tala) == 3
        assert len(ameca) == 1
        assert ameca[0]["id"] == ameca_id
        assert all(row["market_code"] == "TALA-JAL" for row in tala)
        assert all(row["id"] != ameca_id for row in tala)

        # Filtering must precede offset/limit to avoid missing local businesses.
        pages = [
            client.get("/api/v1/restaurants", params={
                "market_code": "TALA-JAL", "offset": offset, "limit": 1,
            }).json()
            for offset in range(3)
        ]
        assert [page[0]["id"] for page in pages] == [row["id"] for row in tala]
        assert client.get("/api/v1/restaurants", params={"market_code": "UNKNOWN-JAL"}).json() == []


def test_category_pickup_and_market_filters_compose():
    with TestClient(app) as client:
        owner = login(client, "restaurante@talaeats.mx", "Restaurante123!")
        profile = client.get("/api/v1/owner/restaurant", headers=owner).json()
        changed = client.patch("/api/v1/owner/restaurant", headers=owner,
                               json={"cuisine": "Carnicería", "pickup_enabled": False})
        assert changed.status_code == 200, changed.text
        all_meat = client.get("/api/v1/restaurants", params={
            "market_code": "TALA-JAL", "cuisine": "Carnicería",
        })
        assert all_meat.status_code == 200, all_meat.text
        assert [row["id"] for row in all_meat.json()] == [profile["id"]]
        pickup = client.get("/api/v1/restaurants", params={
            "market_code": "TALA-JAL", "cuisine": "Carnicería", "pickup_only": "true",
        })
        assert pickup.status_code == 200
        assert pickup.json() == []


def test_only_admin_can_change_market_and_invalid_codes_rejected():
    with TestClient(app) as client:
        existing = client.get("/api/v1/restaurants").json()[0]
        path = f"/api/v1/operations/admin/restaurants/{existing['id']}/market"
        merchant = login(client, "restaurante@talaeats.mx", "Restaurante123!")
        customer = login(client, "cliente@talaeats.mx", "Cliente123!")
        admin = login(client, "admin@talaeats.mx", "Admin123!")

        for headers in (merchant, customer):
            response = client.patch(path, headers=headers, json={"market_code": "AMECA-JAL"})
            assert response.status_code == 403, response.text
        for invalid in ("ameca-jal", "AMECA JAL", "X", "A" * 41):
            response = client.patch(path, headers=admin, json={"market_code": invalid})
            assert response.status_code == 422, response.text
        assert client.patch("/api/v1/operations/admin/restaurants/999999/market",
                            headers=admin, json={"market_code": "AMECA-JAL"}).status_code == 404

        # Existing Tala default is preserved if validation fails.
        assert client.get(f"/api/v1/restaurants/{existing['id']}").json()["market_code"] == "TALA-JAL"
        for invalid in ("TALA/JAL", "a b", "X" * 41):
            response = client.get("/api/v1/restaurants", params={"market_code": invalid})
            assert response.status_code == 422, response.text


def test_catalog_cache_is_separated_by_market_and_category(monkeypatch):
    from app.routes import restaurants as catalog

    cache = {}
    monkeypatch.setattr(catalog, "get_json", lambda key: cache.get(key))
    monkeypatch.setattr(catalog, "set_json", lambda key, value, ttl=20: cache.__setitem__(key, value))
    monkeypatch.setattr(catalog, "catalog_version", lambda: "qa")
    with TestClient(app) as client:
        all_rows = client.get("/api/v1/restaurants").json()
        tala = client.get("/api/v1/restaurants", params={"market_code": "TALA-JAL"}).json()
        pizza = client.get("/api/v1/restaurants", params={
            "market_code": "TALA-JAL", "cuisine": "Pizza",
        }).json()
        assert len(all_rows) == len(tala) == 4
        assert len(pizza) == 1
        assert len(cache) == 3
        assert len(set(cache)) == 3
