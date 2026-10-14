"""Restaurant pickup address and GPS compatibility tests (disposable SQLite)."""
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app import schemas


def auth(client, email, password):
    res=client.post("/api/v1/auth/login",json={"email":email,"password":password})
    assert res.status_code==200,res.text
    return {"Authorization":f"Bearer {res.json()['access_token']}"}


def test_merchant_profile_gps_and_address_persist_and_are_public():
    with TestClient(app) as client:
        merchant=auth(client,"restaurante@talaeats.mx","Restaurante123!")
        before=client.get("/api/v1/owner/restaurant",headers=merchant)
        assert before.status_code==200,before.text
        original=before.json()
        assert "lat" in original and "lng" in original and "address" in original
        new_address="Calle Hidalgo 123, Centro, Tala, Jalisco"
        patch=client.patch("/api/v1/owner/restaurant",headers=merchant,json={"address":new_address,"lat":20.654321,"lng":-103.704321})
        assert patch.status_code==200,patch.text
        assert patch.json()["address"]==new_address
        assert patch.json()["lat"]==pytest.approx(20.654321)
        assert patch.json()["lng"]==pytest.approx(-103.704321)
        after=client.get("/api/v1/owner/restaurant",headers=merchant)
        assert after.status_code==200
        assert after.json()["name"]==original["name"]
        assert after.json()["address"]==new_address
        public=client.get(f'/api/v1/restaurants/{original["id"]}')
        assert public.status_code==200,public.text
        assert public.json()["address"]==new_address
        assert public.json()["lat"]==pytest.approx(20.654321)
        assert public.json()["lng"]==pytest.approx(-103.704321)


@pytest.mark.parametrize("payload", [
    {"lat":20.66},
    {"lng":-103.70},
    {"lat":91,"lng":-103.70},
    {"lat":20.66,"lng":-181},
    {"lat":None,"lng":-103.70},
    {"address":"  "},
])
def test_reject_invalid_location_without_changing_stored_fields(payload):
    with TestClient(app) as client:
        merchant=auth(client,"restaurante@talaeats.mx","Restaurante123!")
        original=client.get("/api/v1/owner/restaurant",headers=merchant).json()
        response=client.patch("/api/v1/owner/restaurant",headers=merchant,json=payload)
        assert response.status_code==422,response.text
        after=client.get("/api/v1/owner/restaurant",headers=merchant).json()
        assert (after["address"],after["lat"],after["lng"])==(original["address"],original["lat"],original["lng"])


def test_legacy_name_only_patch_still_works():
    with TestClient(app) as client:
        merchant=auth(client,"restaurante@talaeats.mx","Restaurante123!")
        resp=client.patch("/api/v1/owner/restaurant",headers=merchant,json={"name":"Restaurante QA"})
        assert resp.status_code==200,resp.text
        assert resp.json()["name"]=="Restaurante QA"


def test_customer_cannot_update_merchant_location():
    with TestClient(app) as client:
        customer=auth(client,"cliente@talaeats.mx","Cliente123!")
        resp=client.patch("/api/v1/owner/restaurant",headers=customer,json={"address":"Calle Hidalgo 123","lat":20.65,"lng":-103.71})
        assert resp.status_code==403,resp.text


def test_contract_rejects_nonfinite_coordinates():
    with pytest.raises(ValueError):
        schemas.RestaurantUpdate.model_validate({"lat":float("inf"),"lng":-103.7})


def test_contract_validation_coords_pair():
    obj=schemas.RestaurantUpdate.model_validate({"address":"  Calle Central 54  ","lat":20.5,"lng":-103.2})
    assert obj.address=="Calle Central 54"
    assert obj.model_dump(exclude_unset=True)=={"address":"Calle Central 54","lat":20.5,"lng":-103.2}
