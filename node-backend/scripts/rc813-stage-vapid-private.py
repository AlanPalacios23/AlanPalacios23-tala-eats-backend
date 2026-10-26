#!/usr/bin/env python3
"""Safely generate PRIVATE VAPID keys for existing isolated stage only.

--plan is read-only.
--configure backs up + atomically edits ONLY isolated staging .env, while
WEB_PUSH_ENABLED stays false. Never invokes PM2 or changes production.
Do not print generated keys or existing environment variables.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import urlopen

SHA = "398b531c4778a03975f30470f6979a38b9c8bb62"
HOME = Path("/home/tala-node-stage")
ROOT = HOME / "tala-node-releases" / SHA / "node-backend"
ENV = HOME / ".config" / "talaeats-node-rc813-parallel.env"
BACKUPS = HOME / "tala-node-stage-backups"
STAGE_PM2 = HOME / ".pm2-tala-rc813-parallel"
NODE = HOME / ".local" / "node24" / "bin" / "node"
APPROVAL = "I_APPROVE_STAGE_VAPID_CONFIG_ONLY"
FLAGS = (
    "STRIPE_FINANCIAL_WRITES_ENABLED", "STRIPE_LIVE_ENABLED",
    "STRIPE_LIVE_RELEASE_APPROVED", "STRIPE_REFUNDS_ENABLED",
    "STRIPE_CONNECT_TRANSFERS_ENABLED", "STRIPE_MANUAL_SETTLEMENT_APPROVED",
    "STAGE_STRIPE_TEST_CHECKOUT_ENABLED", "STAGE_DELIVERY_STRIPE_TEST_ENABLED",
)


def stop(reason: str) -> None:
    print("RC813_VAPID_CONFIG_HOLD=" + reason, flush=True)
    raise SystemExit(1)


def regular_owned_private(path: Path, mode: int) -> bool:
    try:
        info = path.lstat()
        return (stat.S_ISREG(info.st_mode) and
                info.st_uid == os.geteuid() and
                stat.S_IMODE(info.st_mode) == mode)
    except OSError:
        return False


def directory_owned_private(path: Path, mode: int) -> bool:
    try:
        info = path.lstat()
        return (stat.S_ISDIR(info.st_mode) and
                info.st_uid == os.geteuid() and
                stat.S_IMODE(info.st_mode) == mode)
    except OSError:
        return False


def parse_env(raw: str) -> dict[str, str]:
    rows = {}
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            stop("MALFORMED_STAGE_ENV")
        k, v = line.split("=", 1)
        k = k.strip()
        if not k.isidentifier() or k in rows:
            stop("DUPLICATE_OR_MALFORMED_ENV_KEY")
        rows[k] = v.strip().strip("'").strip('"')
    return rows


def check_stage_config(v: dict[str, str]) -> None:
    try:
        pg = urlsplit(v["DATABASE_URL"])
        rd = urlsplit(v["REDIS_URL"])
        if (v.get("NODE_ENV") != "staging" or
            v.get("STAGE_PARALLEL_ENABLED") != "true" or
            v.get("HOST") != "127.0.0.1" or
            v.get("PORT") != "18192" or
            pg.scheme not in ("postgres", "postgresql") or
            pg.hostname != "127.0.0.1" or pg.port != 15435 or
            pg.username != "tala_node_stage" or
            pg.path != "/tala_node_stage" or not pg.password or
            rd.scheme not in ("redis", "rediss") or
            rd.hostname != "127.0.0.1" or rd.port != 16379 or
            rd.path != "/1" or not rd.password or
            any(v.get(k, "false") != "false" for k in FLAGS) or
            v.get("WEB_PUSH_ENABLED", "false") != "false"):
            stop("STAGE_ISOLATION_OR_WEB_PUSH_ALREADY_ENABLED")
        stripe = v.get("STRIPE_SECRET_KEY", "")
        if stripe and not stripe.startswith(("sk_test_", "rk_test_")):
            stop("STRIPE_LIVE_KEY_IN_STAGE")
        publishable = v.get("STRIPE_PUBLISHABLE_KEY", "")
        if publishable and not publishable.startswith("pk_test_"):
            stop("STRIPE_LIVE_PUBLISHABLE_IN_STAGE")
        if any(k.upper().startswith("MERCADOPAGO_") for k in v):
            stop("MERCADOPAGO_FORBIDDEN")
    except (KeyError, TypeError, ValueError):
        stop("STAGE_DATABASE_OR_REDIS_URL_INVALID")


def check_live_and_stage() -> None:
    for port, expect in (
        (18190, lambda a: a.get("environment") == "production" and
         a.get("financialWrites") is True and a.get("onlinePaymentsEnabled") is True),
        (18192, lambda a: a.get("environment") == "staging" and
         a.get("ready") is True and a.get("workerOnline") is True and
         a.get("financialWrites") is False and a.get("onlinePaymentsEnabled") is False),
    ):
        try:
            with urlopen(f"http://127.0.0.1:{port}/api/v1/ready", timeout=4) as res:
                payload = json.loads(res.read(4096))
                if res.status != 200 or not expect(payload):
                    stop(f"BACKEND_{port}_UNEXPECTED_STATUS")
        except Exception:
            stop(f"BACKEND_{port}_UNREACHABLE_OR_UNEXPECTED")
    with urlopen("http://127.0.0.1:18192/api/v1/v11/push/config", timeout=4) as res:
        settings = json.loads(res.read(4096))
        if settings != {"enabled": False, "public_key": None}:
            stop("PUSH_ALREADY_ADVERTISED_OR_UNKNOWN")
    print("RC813_LIVE_18190_PAYMENT_CAPABLE_UNCHANGED=PASS")
    print("RC813_STAGE_18192_READY_MONEY_OFF=PASS")
    print("RC813_PUSH_CURRENTLY_DISABLED=PASS")


def keys_present(v: dict[str, str]) -> bool:
    names = ("WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY", "WEB_PUSH_SUBJECT")
    exists = [bool(v.get(n)) for n in names]
    if any(exists) and not all(exists):
        stop("PARTIAL_VAPID_KEYS_REVIEW")
    return all(exists)


def verify_pm2_home() -> None:
    if (STAGE_PM2.is_symlink() or not STAGE_PM2.is_dir() or
        STAGE_PM2.stat().st_uid != os.geteuid()):
        stop("ISOLATED_PM2_NOT_OWNED_OR_RUNNING")
    if not NODE.is_file():
        stop("NODE24_NOT_INSTALLED")
    if not (ROOT / "node_modules" / "web-push").is_dir():
        stop("PINNED_RELEASE_NOT_PREPARED")
    try:
        check = subprocess.run(
            ["git", "-C", str(ROOT.parent), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5, check=True)
        if check.stdout.strip() != SHA:
            stop("RELEASE_SHA_MISMATCH")
    except (OSError, subprocess.SubprocessError):
        stop("RELEASE_SHA_UNVERIFIED")


def generate_vapid() -> dict[str, str]:
    script = ("import webpush from 'web-push';"
              "process.stdout.write(JSON.stringify(webpush.generateVAPIDKeys()))")
    proc = subprocess.run(
        [str(NODE), "--input-type=module", "-e", script],
        cwd=ROOT, env={
            "HOME": str(HOME),
            "PATH": str(HOME / ".local/node24/bin") + ":/usr/bin:/bin",
            "NODE_ENV": "staging",
        }, capture_output=True, text=True, timeout=20, check=False)
    if proc.returncode != 0:
        stop("VAPID_KEY_GENERATION_FAILED")
    try:
        keys = json.loads(proc.stdout)
        if (not re.fullmatch(r"[A-Za-z0-9_-]{86,88}", keys["publicKey"]) or
            not re.fullmatch(r"[A-Za-z0-9_-]{42,44}", keys["privateKey"])):
            stop("VAPID_KEYS_BAD_FORMAT")
        return keys
    except (ValueError, KeyError, TypeError):
        stop("VAPID_KEY_GENERATION_INVALID")


def backup_and_write(raw: str, keys: dict[str, str], subject: str) -> None:
    if not directory_owned_private(BACKUPS, 0o700):
        stop("PRIVATE_BACKUP_DIRECTORY_REQUIRED")
    import datetime
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = BACKUPS / f"rc813-stage-env-pre-vapid-{stamp}-{os.getpid()}.env"
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        file.write(raw)
        file.flush()
        os.fsync(file.fileno())
    new = "\n".join(
        line for line in raw.splitlines()
        if not re.match(
            r"\s*(WEB_PUSH_ENABLED|WEB_PUSH_VAPID_PUBLIC_KEY|WEB_PUSH_VAPID_PRIVATE_KEY|WEB_PUSH_SUBJECT)\s*=",
            line,
        )
    ) + "\n"
    new += (
        "WEB_PUSH_ENABLED=false\n"
        f"WEB_PUSH_VAPID_PUBLIC_KEY={keys['publicKey']}\n"
        f"WEB_PUSH_VAPID_PRIVATE_KEY={keys['privateKey']}\n"
        f"WEB_PUSH_SUBJECT={subject}\n"
    )
    # Validate structure, permission and stage flags BEFORE atomic swap.
    v = parse_env(new)
    check_stage_config(v)
    if not keys_present(v):
        stop("NEW_KEYS_MISSING")
    handle, tmp = tempfile.mkstemp(prefix=".vapid-stage-", dir=ENV.parent)
    try:
        os.fchmod(handle, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(new)
            file.flush()
            os.fsync(file.fileno())
        if not regular_owned_private(ENV, 0o600):
            stop("STAGE_ENV_CHANGED")
        os.replace(tmp, ENV)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    print("RC813_VAPID_PRIVATE_BACKUP_SAVED=PASS")
    print("RC813_VAPID_KEYS_GENERATED_AND_SAVED=PASS")
    print("RC813_VAPID_REMAINS_DISABLED=YES")
    print("RC813_NO_PM2_RESTART=YES")
    print("RC813_LIVE_UNTOUCHED=YES")


def main() -> None:
    args = sys.argv[1:]
    if args != ["--plan"] and not (
        len(args) == 3 and args[0] == "--configure" and args[1] == APPROVAL
    ):
        stop("USAGE_PLAN_OR_CONFIGURE_EXPLICITLY")
    if os.geteuid() == 0 or pwd.getpwuid(os.geteuid()).pw_name != "tala-node-stage":
        stop("STAGE_SERVICE_USER_ONLY")
    if not regular_owned_private(ENV, 0o600):
        stop("PRIVATE_STAGE_ENV_REQUIRED")
    verify_pm2_home()
    raw = ENV.read_text(encoding="utf-8")
    values = parse_env(raw)
    check_stage_config(values)
    check_live_and_stage()
    if keys_present(values):
        stop("EXISTING_VAPID_KEYS_NEVER_OVERWRITE")
    print("RC813_STAGE_VAPID_ABSENT=PASS")
    if args == ["--plan"]:
        print("RC813_VAPID_PLAN_READ_ONLY=PASS")
        return
    subject = args[2]
    if not re.fullmatch(r"mailto:[^\s@]+@[^\s@]+", subject):
        stop("VAPID_SUBJECT_MUST_BE_MAILTO")
    keys = generate_vapid()
    backup_and_write(raw, keys, subject)


if __name__ == "__main__":
    main()
