"""Explicit, one-time bootstrap for a NEW admin account.

NEVER elevate an existing customer/driver/restaurant to admin on restart.
Production entrypoint never calls this module. Operators must explicitly set
BOOTSTRAP_ADMIN_ENABLED=true and run `python -m app.bootstrap_admin` in
an audited, one-time maintenance context (not a recurring runtime env flag).
"""
from __future__ import annotations

import os
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .db import SessionLocal
from .models import User
from .security import hash_password


def bootstrap_admin() -> bool:
    """Create an absent admin only; do not change roles or passwords on rerun."""
    enabled = os.getenv("BOOTSTRAP_ADMIN_ENABLED", "").strip().lower()
    if enabled not in {"true", "1", "yes", "on"}:
        print("[Tala Eats] Admin bootstrap disabled; no changes")
        return False

    email = os.getenv("BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
    password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD", "")
    name = os.getenv("BOOTSTRAP_ADMIN_NAME", "Tala Eats Admin").strip()
    if (not email or len(email) > 254 or email.count("@") != 1
            or email.startswith("@") or email.endswith("@")):
        raise SystemExit("BOOTSTRAP_ADMIN_EMAIL válido es obligatorio")
    if len(password) < 20:
        raise SystemExit("BOOTSTRAP_ADMIN_PASSWORD debe tener al menos 20 caracteres")

    with SessionLocal() as db:
        existing = db.scalar(select(User).where(User.email == email))
        if existing:
            # Even with bootstrap explicitly enabled, role escalation and
            # reviving suspended accounts require a separate audited workflow.
            if existing.role != "admin" or not existing.is_active:
                raise SystemExit("Bootstrap denegado: cuenta existente no elegible")
            print("[Tala Eats] Admin already exists; no changes")
            return False

        user = User(
            name=name or "Tala Eats Admin", email=email,
            password_hash=hash_password(password),
            role="admin", auth_provider="local", is_active=True,
        )
        db.add(user)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise SystemExit("Admin bootstrap conflict; review database and retry securely") from exc
    print("[Tala Eats] New admin account created; configure TOTP before privileged access")
    return True


if __name__ == "__main__":
    bootstrap_admin()
