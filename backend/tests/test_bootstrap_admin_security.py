"""Privileged admin creation is opt-in and never promotes existing users."""
import pytest
from sqlalchemy import select

from app import models
from app.bootstrap_admin import bootstrap_admin
from app.db import SessionLocal
from app.security import verify_password


def test_bootstrap_is_noop_without_explicit_flag(monkeypatch):
    monkeypatch.delenv("BOOTSTRAP_ADMIN_ENABLED", raising=False)
    monkeypatch.setenv("BOOTSTRAP_ADMIN_EMAIL", "cliente@talaeats.mx")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", "x" * 32)
    assert bootstrap_admin() is False
    with SessionLocal() as db:
        user = db.scalar(select(models.User).where(models.User.email == "cliente@talaeats.mx"))
        assert user.role == "customer"


def test_bootstrap_never_elevates_existing_customer(monkeypatch):
    monkeypatch.setenv("BOOTSTRAP_ADMIN_ENABLED", "true")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_EMAIL", "cliente@talaeats.mx")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", "x" * 32)
    with pytest.raises(SystemExit, match="no elegible"):
        bootstrap_admin()
    with SessionLocal() as db:
        user = db.scalar(select(models.User).where(models.User.email == "cliente@talaeats.mx"))
        assert user.role == "customer"


def test_explicit_bootstrap_creates_once_without_password_rotation(monkeypatch):
    monkeypatch.setenv("BOOTSTRAP_ADMIN_ENABLED", "true")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_EMAIL", "new-admin-qa@talaeats.example")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", "A-long-test-only-passphrase-2026!")
    assert bootstrap_admin() is True
    with SessionLocal() as db:
        admin = db.scalar(select(models.User).where(models.User.email == "new-admin-qa@talaeats.example"))
        assert admin.role == "admin"
        assert verify_password("A-long-test-only-passphrase-2026!", admin.password_hash)
        saved_hash = admin.password_hash
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", "Different-long-test-passphrase-2026!")
    assert bootstrap_admin() is False
    with SessionLocal() as db:
        admin = db.scalar(select(models.User).where(models.User.email == "new-admin-qa@talaeats.example"))
        assert admin.password_hash == saved_hash


def test_bootstrap_rejects_short_credentials_even_when_enabled(monkeypatch):
    monkeypatch.setenv("BOOTSTRAP_ADMIN_ENABLED", "true")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_EMAIL", "new-admin-qa@talaeats.example")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", "short")
    with pytest.raises(SystemExit, match="20 caracteres"):
        bootstrap_admin()
