"""Phase-1 auth, revocation, role and bank-owner regression tests.

Uses disposable SQLite accounts. No PSP credentials or provider network requests.
"""
from datetime import datetime, timedelta, timezone
import hashlib

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app
from app.routes.withdrawals import _self_service_owner


def _login(client, email, password):
    res = client.post("/api/v1/auth/login", headers={"X-TalaEats-Client": "customer-mobile"},
                      json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": "Bearer " + res.json()["access_token"]}


def test_logout_revokes_only_its_own_session_and_rejects_replay():
    with TestClient(app) as client:
        first = _login(client, "cliente@talaeats.mx", "Cliente123!")
        second = _login(client, "cliente@talaeats.mx", "Cliente123!")
        assert client.get("/api/v1/auth/me", headers=first).status_code == 200
        logout = client.post("/api/v1/auth/logout", headers=first)
        assert logout.status_code == 204
        assert client.get("/api/v1/auth/me", headers=first).status_code == 401
        assert client.get("/api/v1/auth/me", headers=second).status_code == 200


def test_password_reset_invalidates_all_existing_access_tokens():
    with TestClient(app) as client:
        old = _login(client, "cliente@talaeats.mx", "Cliente123!")
        other = _login(client, "cliente@talaeats.mx", "Cliente123!")
        raw = "synthetic-reset-token-just-for-test"
        with SessionLocal() as db:
            user = db.scalar(select(models.User).where(models.User.email == "cliente@talaeats.mx"))
            db.add(models.PasswordResetToken(
                user_id=user.id,
                token_hash=hashlib.sha256(raw.encode()).hexdigest(),
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
            ))
            db.commit()
        changed = client.post("/api/v1/auth/password/reset", json={
            "token": raw, "password": "ChangedPassword123!"
        })
        assert changed.status_code == 200, changed.text
        assert client.get("/api/v1/auth/me", headers=old).status_code == 401
        assert client.get("/api/v1/auth/me", headers=other).status_code == 401
        assert client.post("/api/v1/auth/password/reset", json={
            "token": raw, "password": "AnotherPassword123!"
        }).status_code == 400
        new = _login(client, "cliente@talaeats.mx", "ChangedPassword123!")
        assert client.get("/api/v1/auth/me", headers=new).status_code == 200


def test_admin_endpoint_requires_2fa_when_privileged_guard_active(monkeypatch):
    monkeypatch.setattr(settings, "require_privileged_2fa", True)
    with TestClient(app) as client:
        admin = _login(client, "admin@talaeats.mx", "Admin123!")
        customer = _login(client, "cliente@talaeats.mx", "Cliente123!")
        url = "/api/v1/v11/admin/command-center"
        assert client.get(url, headers=admin).status_code == 403
        assert client.get(url, headers=customer).status_code == 403
        with SessionLocal() as db:
            user = db.scalar(select(models.User).where(models.User.email == "admin@talaeats.mx"))
            user.two_factor_enabled = True
            db.commit()
        assert client.get(url, headers=admin).status_code == 200


def test_stripe_connect_bank_owner_cannot_cross_restaurant_or_driver():
    with SessionLocal() as db:
        customer = db.scalar(select(models.User).where(models.User.role == "customer"))
        owner = db.scalar(select(models.User).where(models.User.role == "restaurant"))
        driver = db.scalar(select(models.User).where(models.User.role == "driver"))
        restaurant = db.scalar(select(models.Restaurant).where(models.Restaurant.owner_id == owner.id))
        assert restaurant is not None
        with pytest.raises(HTTPException) as denied:
            _self_service_owner(db, customer, "restaurant", restaurant.id)
        assert denied.value.status_code == 404
        with pytest.raises(HTTPException) as denied:
            _self_service_owner(db, owner, "driver", driver.id)
        assert denied.value.status_code == 404
        with pytest.raises(HTTPException) as denied:
            _self_service_owner(db, driver, "driver", owner.id)
        assert denied.value.status_code == 404
        own = _self_service_owner(db, driver, "driver", driver.id)
        assert own.user_id == driver.id
