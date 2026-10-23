#!/usr/bin/env python3
"""Install Stripe LIVE credentials privately for Tala Eats on Kali.

Configuration preparation ONLY. Never starts services, creates charges, or
changes the deployed staging PM2 process.
"""
from __future__ import annotations
import getpass
import os
import pwd
import re
import stat
import sys
import tempfile
from pathlib import Path

SERVICE_USER = "tala-node-stage"
TARGET = Path(f"/home/{SERVICE_USER}/.config/talaeats-node-live.env")
PLATFORM_ACCOUNT_ID = "acct_1UB69APUp8Tz0qUa"
CONNECTED_ACCOUNT_ID = "acct_1UTm0lBmsG4BQXBD"

def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)

def prompt(label: str, pattern: str) -> str:
    try:
        value = getpass.getpass(f"{label} (entrada oculta): ")
    except (EOFError, KeyboardInterrupt):
        fail("Ingreso cancelado; no se escribieron credenciales")
    if not re.fullmatch(pattern, value):
        fail(f"Formato no válido para {label}; archivo sin modificar")
    return value

def main() -> None:
    try:
        identity = pwd.getpwnam(SERVICE_USER)
    except KeyError:
        fail(f"No existe la cuenta Linux {SERVICE_USER}")
    if os.geteuid() != identity.pw_uid:
        fail(f"Ejecutar como {SERVICE_USER}: sudo -u {SERVICE_USER} python3 <ruta_del_script>")
    print("TALA EATS — credenciales Stripe LIVE (solo almacenamiento seguro)")
    print("Cuenta principal:", PLATFORM_ACCOUNT_ID)
    print("Cuenta Connect:", CONNECTED_ACCOUNT_ID)
    print("No modifica staging, PM2, bases de datos ni activa cobros.")

    if TARGET.parent.is_symlink() or TARGET.is_symlink():
        fail("Ruta insegura: enlace simbólico encontrado")
    TARGET.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode = stat.S_IMODE(TARGET.parent.stat().st_mode)
    if TARGET.parent.stat().st_uid != identity.pw_uid or mode & 0o077:
        fail("El directorio .config debe pertenecer a tala-node-stage y ser privado (0700)")
    if TARGET.exists() and (not TARGET.is_file() or TARGET.stat().st_uid != identity.pw_uid):
        fail("El archivo existente no pertenece al usuario esperado")
    if TARGET.exists():
        response = input("El archivo LIVE existe. Para reemplazarlo escribe REEMPLAZAR: ").strip()
        if response != "REEMPLAZAR":
            fail("Sin cambios")

    secret = prompt("Stripe API secret LIVE (rk_live_ / sk_live_)", r"(?:rk|sk)_live_[A-Za-z0-9]{16,}")
    publishable = prompt("Stripe publishable LIVE (pk_live_)", r"pk_live_[A-Za-z0-9]{16,}")
    webhook = prompt("Stripe signing secret webhook LIVE (whsec_)", r"whsec_[A-Za-z0-9]{16,}")

    # IMPORTANT: credentials installed != permission to take customer payments.
    variables = {
        "NODE_ENV": "production",
        "STRIPE_SECRET_KEY": secret,
        "STRIPE_PUBLISHABLE_KEY": publishable,
        "STRIPE_WEBHOOK_SECRET": webhook,
        "STRIPE_PLATFORM_ACCOUNT_ID": PLATFORM_ACCOUNT_ID,
        "STRIPE_CONNECTED_ACCOUNT_ID": CONNECTED_ACCOUNT_ID,
        "STRIPE_LIVE_ENABLED": "false",
        "STRIPE_LIVE_RELEASE_APPROVED": "false",
        "STRIPE_FINANCIAL_WRITES_ENABLED": "false",
    }
    payload = "# DO NOT COMMIT — Tala Eats dedicated Stripe LIVE credentials\n" + "".join(
        f"{key}={value}\n" for key, value in variables.items()
    )
    os.umask(0o077)
    temporary_name = None
    try:
        fd, temporary_name = tempfile.mkstemp(prefix=".stripe-live-", dir=TARGET.parent)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, TARGET)
        temporary_name = None
        dir_fd = os.open(TARGET.parent, os.O_DIRECTORY | os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass

    print("STRIPE_LIVE_CREDENTIALS_SAVED=YES")
    print("PRIVATE_FILE_PERMISSIONS=0600")
    print("CHECKOUT_AND_FINANCIAL_WRITES=DISABLED_UNTIL_PRODUCTION_GATES_PASS")
    print("Staging permanece intacto. No subir este archivo a GitHub o al chat.")

if __name__ == "__main__":
    main()
