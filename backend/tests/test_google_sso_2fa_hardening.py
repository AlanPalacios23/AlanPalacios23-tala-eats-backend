"""MFA and Google identity-linking regressions with fake verified ID tokens."""
import sys
import time
import types

from fastapi.testclient import TestClient
from sqlalchemy import select

from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app
from app.security import _totp_code


def install_fake_google(monkeypatch, *, email: str, sub: str = "google-unique-2026"):
    google = types.ModuleType("google")
    auth = types.ModuleType("google.auth")
    transport = types.ModuleType("google.auth.transport")
    requests_mod = types.ModuleType("google.auth.transport.requests")
    oauth2 = types.ModuleType("google.oauth2")
    id_token = types.ModuleType("google.oauth2.id_token")

    class Request:
        pass

    requests_mod.Request = Request
    id_token.verify_oauth2_token = lambda credential, request, audience: {
        "sub": sub, "email": email, "email_verified": True,
        "name": "QA signed in with Google", "picture": None,
    }
    google.auth = auth
    google.oauth2 = oauth2
    auth.transport = transport
    transport.requests = requests_mod
    oauth2.id_token = id_token
    for name, module in (
        ("google", google), ("google.auth", auth),
        ("google.auth.transport", transport),
        ("google.auth.transport.requests", requests_mod),
        ("google.oauth2", oauth2), ("google.oauth2.id_token", id_token),
    ):
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(settings, "google_client_id", "qa-client-id.apps.googleusercontent.com")


def configure_customer(**values):
    with SessionLocal() as db:
        user = db.scalar(select(models.User).where(models.User.email == "cliente@talaeats.mx"))
        assert user is not None
        for name, value in values.items():
            setattr(user, name, value)
        db.commit()


def test_google_sso_cannot_bypass_totp_or_link_before_mfa(monkeypatch):
    secret = "JBSWY3DPEHPK3PXP"
    configure_customer(two_factor_enabled=True, totp_secret=secret, google_sub=None)
    install_fake_google(monkeypatch, email="cliente@talaeats.mx")
    with TestClient(app) as client:
        no_otp = client.post("/api/v1/auth/google", json={"credential": "fake" * 11})
        assert no_otp.status_code == 401
        wrong = client.post("/api/v1/auth/google", json={"credential": "fake" * 11, "otp": "000000" if _totp_code(secret, int(time.time() // 30)) != "000000" else "999999"})
        assert wrong.status_code == 401
        with SessionLocal() as db:
            user = db.scalar(select(models.User).where(models.User.email == "cliente@talaeats.mx"))
            assert user.google_sub is None
        code = _totp_code(secret, int(time.time() // 30))
        allowed = client.post("/api/v1/auth/google", json={"credential": "fake" * 11, "otp": code})
        assert allowed.status_code == 200, allowed.text
        assert allowed.json()["access_token"]


def test_google_sso_blocks_link_to_different_google_identity(monkeypatch):
    configure_customer(google_sub="original-google-sub", two_factor_enabled=False)
    install_fake_google(monkeypatch, email="cliente@talaeats.mx", sub="new-google-sub")
    with TestClient(app) as client:
        result = client.post("/api/v1/auth/google", json={"credential": "fake" * 11})
        assert result.status_code == 409
        with SessionLocal() as db:
            user = db.scalar(select(models.User).where(models.User.email == "cliente@talaeats.mx"))
            assert user.google_sub == "original-google-sub"


def test_disabled_customer_google_login_does_not_link_account(monkeypatch):
    configure_customer(is_active=False, google_sub=None, two_factor_enabled=False)
    install_fake_google(monkeypatch, email="cliente@talaeats.mx")
    with TestClient(app) as client:
        result = client.post("/api/v1/auth/google", json={"credential": "fake" * 11})
        assert result.status_code == 403
        with SessionLocal() as db:
            user = db.scalar(select(models.User).where(models.User.email == "cliente@talaeats.mx"))
            assert user.google_sub is None
