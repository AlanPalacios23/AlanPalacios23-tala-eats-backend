#!/usr/bin/env python3
"""RC8.3 LIVE PM2 env wizard — does not touch PM2, Stripe, DB or Redis.
Run exclusively as tala-node-stage. Creates a protected configuration
with ALL financial release switches disabled.
"""
import getpass
import os
import pwd
import re
import stat
import sys
import tempfile
from pathlib import Path
USER = "tala-node-stage"
HOME = Path("/home") / USER
TARGET = HOME / ".config" / "talaeats-node-live.env"

def abort(message):
    print("ABORT_" + message, file=sys.stderr)
    raise SystemExit(1)

def hidden(name, pattern):
    try:
        value = getpass.getpass(name + " (oculto): ")
    except (EOFError, KeyboardInterrupt):
        abort("CANCELADO")
    if not re.fullmatch(pattern, value):
        abort("INVALID_" + name.replace(" ", "_").upper())
    return value

def main():
    try:
        identity=pwd.getpwnam(USER)
    except KeyError:
        abort("SERVICE_USER_MISSING")
    if os.geteuid()!=identity.pw_uid:
        abort("RUN_AS_TALA_NODE_STAGE")
    parent=TARGET.parent
    if parent.is_symlink() or TARGET.is_symlink():
        abort("SYMLINK")
    parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    if parent.stat().st_uid!=identity.pw_uid or (stat.S_IMODE(parent.stat().st_mode)&0o077):
        abort("PRIVATE_DIRECTORY_REQUIRED")
    if TARGET.exists():
        if not TARGET.is_file() or TARGET.stat().st_uid!=identity.pw_uid:
            abort("UNEXPECTED_TARGET")
        if input("Ya hay archivo LIVE. Para reemplazar escribe REEMPLAZAR: ").strip()!="REEMPLAZAR":
            abort("NO_CHANGES")

    print("RC8.3 credenciales de producción (no activa cobros)")
    pg=hidden("PostgreSQL production URL",r"postgres(?:ql)?://[^\s#]+")
    redis=hidden("Redis production URL",r"rediss?://[^\s#]+")
    jwt=hidden("AUTH JWT SECRET exclusivo producción",r"[A-Za-z0-9_-]{48,256}")
    key=hidden("Stripe sk_live o rk_live",r"(?:sk|rk)_live_[A-Za-z0-9]{16,}")
    pub=hidden("Stripe pk_live",r"pk_live_[A-Za-z0-9]{16,}")
    whsec=hidden("Stripe whsec LIVE",r"whsec_[A-Za-z0-9]{16,}")
    from urllib.parse import urlsplit
    p=urlsplit(pg); r=urlsplit(redis)
    if not p.username or not p.password or not p.hostname or not r.password or not r.hostname:
        abort("PG_REDIS_CREDENTIALS_REQUIRED")
    if p.path=="/tala_node_stage" or p.username=="tala_node_stage" or (
        p.hostname=="127.0.0.1" and p.port==15435):
        abort("STAGING_POSTGRES_FORBIDDEN")
    if r.hostname=="127.0.0.1" and r.port==16379 and r.path in ("","/0"):
        abort("STAGING_REDIS_FORBIDDEN")
    variables={
        "NODE_ENV":"production",
        "HOST":"127.0.0.1",
        "PORT":"18190",
        "DATABASE_URL":pg,"REDIS_URL":redis,
        "AUTH_JWT_SECRET":jwt,
        "AUTH_V02_ENABLED":"true",
        "MARKETPLACE_B_ENABLED":"true",
        "STAGE_PICKUP_CASH_CHECKOUT_ENABLED":"true",
        "STAGE_STRIPE_TEST_CHECKOUT_ENABLED":"false",
        "STAGE_DRIVER_DELIVERY_ENABLED":"false",
        "STAGE_EMAIL_DELIVERY_MODE":"disabled",
        "STRIPE_SECRET_KEY":key,
        "STRIPE_PUBLISHABLE_KEY":pub,
        "STRIPE_WEBHOOK_SECRET":whsec,
        "STRIPE_PLATFORM_ACCOUNT_ID":"acct_1UB69APUp8Tz0qUa",
        "STRIPE_CONNECTED_ACCOUNT_ID":"acct_1UTm0lBmsG4BQXBD",
        "STRIPE_LIVE_MAX_ORDER_MINOR":"50000",
        "STRIPE_LIVE_ENABLED":"false",
        "STRIPE_LIVE_RELEASE_APPROVED":"false",
        "STRIPE_FINANCIAL_WRITES_ENABLED":"false",
        "STRIPE_REFUNDS_ENABLED":"false",
        "STRIPE_MANUAL_SETTLEMENT_APPROVED":"false",
        "STRIPE_CONNECT_TRANSFERS_ENABLED":"false",
    }
    # Validate a complete resulting file before replacing any prior version.
    payload="# RC8.3 STRICTLY PRIVATE — LIVE remains OFF until approved\n"
    payload+="".join(key+"="+value+"\n" for key,value in variables.items())
    os.umask(0o077)
    temporary=None
    try:
        fd,temporary=tempfile.mkstemp(prefix=".tala-live-",dir=parent)
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"w",encoding="utf8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary,TARGET)
        temporary=None
    finally:
        if temporary:
            try: os.unlink(temporary)
            except FileNotFoundError: pass
    print("RC83_PRIVATE_ENV=PASS")
    print("FILE_MODE=0600")
    print("FINANCIAL_WRITES=OFF_PENDING_SIGNOFF")
    print("PM2_UNCHANGED=YES")
    print("Nunca compartir este archivo o las claves en chat, consola o GitHub.")
if __name__=="__main__": main()
