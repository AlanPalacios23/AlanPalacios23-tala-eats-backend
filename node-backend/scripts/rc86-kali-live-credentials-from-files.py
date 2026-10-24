#!/usr/bin/env python3
"""Prepare RC8.6 LIVE env from existing private PG/Redis URLs on Kali.

Never starts PM2, changes databases, or enables a real charge. All new Stripe
credentials are collected with hidden input. The existing LIVE env is not
overwritten to avoid accidental JWT/session rotation.
"""
import getpass
import os
import pwd
import re
import secrets
import stat
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

USER = "tala-node-stage"
HOME = Path("/home") / USER
PRIVATE = HOME / ".config"
TARGET = PRIVATE / "talaeats-node-live.env"

def stop(reason):
    print("RC86_LIVE_ENV=HOLD_" + reason, file=sys.stderr)
    raise SystemExit(1)

def read_secret_file(filename):
    path = PRIVATE / filename
    if path.is_symlink() or not path.is_file():
        stop("PRIVATE_URL_MISSING")
    meta = path.stat()
    if meta.st_uid != os.getuid() or stat.S_IMODE(meta.st_mode) != 0o600:
        stop("PRIVATE_URL_PERMISSIONS")
    value = path.read_text(encoding="utf-8").strip()
    if not value or "\n" in value or "\r" in value or len(value) > 2000:
        stop("PRIVATE_URL_INVALID")
    return value

def hidden(label, expr):
    try:
        value = getpass.getpass(label + " (oculto): ")
    except (EOFError, KeyboardInterrupt):
        stop("CANCELLED")
    if not re.fullmatch(expr, value):
        stop("KEY_FORMAT")
    return value

def main():
    identity = pwd.getpwnam(USER)
    if os.geteuid() != identity.pw_uid or os.geteuid() == 0:
        stop("SERVICE_USER_REQUIRED")
    if PRIVATE.is_symlink() or TARGET.is_symlink() or not PRIVATE.is_dir():
        stop("PRIVATE_DIRECTORY_INVALID")
    info = PRIVATE.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        stop("PRIVATE_DIRECTORY_PERMISSIONS")
    if TARGET.exists():
        stop("LIVE_ENV_ALREADY_EXISTS_NO_REPLACEMENT")

    pg = read_secret_file("talaeats-live-db-url")
    redis = read_secret_file("talaeats-live-redis-url")
    p, r = urlsplit(pg), urlsplit(redis)
    if (p.scheme not in ("postgres", "postgresql")
        or p.hostname != "127.0.0.1" or p.port != 15445
        or p.username != "tala_node_live" or p.path != "/tala_node_live"
        or not p.password):
        stop("POSTGRES_LIVE_URL_MISMATCH")
    if (r.scheme != "redis" or r.hostname != "127.0.0.1"
        or r.port != 16380 or r.path != "/0" or not r.password):
        stop("REDIS_LIVE_URL_MISMATCH")

    print("RC8.6: guardar Stripe LIVE privado, sin activar cobros ni tocar PM2")
    key = hidden("Stripe sk_live o rk_live", r"(?:sk|rk)_live_[A-Za-z0-9]{16,}")
    pub = hidden("Stripe pk_live", r"pk_live_[A-Za-z0-9]{16,}")
    wh = hidden("Stripe webhook whsec LIVE", r"whsec_[A-Za-z0-9]{16,}")
    auth = secrets.token_urlsafe(48)
    pairs = {
        "NODE_ENV": "production",
        "HOST": "127.0.0.1",
        "PORT": "18190",
        "DATABASE_URL": pg,
        "REDIS_URL": redis,
        "AUTH_JWT_SECRET": auth,
        "AUTH_V02_ENABLED": "true",
        "MARKETPLACE_B_ENABLED": "true",
        "STAGE_PICKUP_CASH_CHECKOUT_ENABLED": "true",
        "STAGE_STRIPE_TEST_CHECKOUT_ENABLED": "false",
        "STAGE_DRIVER_DELIVERY_ENABLED": "false",
        "STAGE_EMAIL_DELIVERY_MODE": "disabled",
        "STRIPE_SECRET_KEY": key,
        "STRIPE_PUBLISHABLE_KEY": pub,
        "STRIPE_WEBHOOK_SECRET": wh,
        "STRIPE_PLATFORM_ACCOUNT_ID": "acct_1UB69APUp8Tz0qUa",
        "STRIPE_LIVE_MAX_ORDER_MINOR": "50000",
        "STRIPE_LIVE_ENABLED": "false",
        "STRIPE_LIVE_RELEASE_APPROVED": "false",
        "STRIPE_FINANCIAL_WRITES_ENABLED": "false",
        "STRIPE_REFUNDS_ENABLED": "false",
        "STRIPE_MANUAL_SETTLEMENT_APPROVED": "false",
        "STRIPE_CONNECT_TRANSFERS_ENABLED": "false",
    }
    payload = "# TALA EATS PRIVATE LIVE — all charges remain OFF pending proof\n"
    payload += "".join(f"{name}={value}\n" for name, value in pairs.items())
    os.umask(0o077)
    temp = None
    try:
        fd, temp = tempfile.mkstemp(prefix=".rc86-live-", dir=PRIVATE)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        if TARGET.exists():
            stop("RACE_EXISTING_ENV")
        os.replace(temp, TARGET)
        temp = None
    finally:
        if temp:
            os.unlink(temp)
    print("RC86_PRIVATE_ENV=PASS")
    print("POSTGRES_AND_REDIS=ISOLATED")
    print("STRIPE_LIVE_CHARGES=OFF")
    print("CONNECT_TRANSFERS=OFF")
    print("PM2_PUBLIC=UNCHANGED")

if __name__ == "__main__":
    main()
