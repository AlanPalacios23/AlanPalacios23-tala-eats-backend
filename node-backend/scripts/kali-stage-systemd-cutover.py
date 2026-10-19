#!/usr/bin/env python3
"""Stage-only controlled handoff to existing user-systemd units.

--plan: read-only, verifies stage API, PM2 state, services, backup.
--apply: explicitly approved; stops only manually launched stage processes,
starts only the three enabled stage USER units. On failure tries to restore
manual stage services, with no Docker, PG18, payment or system root access.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import subprocess
import sys
import time
import urllib.request
from urllib.parse import unquote, urlsplit

HOME = Path("/home/tala-node-stage")
ROOT = HOME / "talaeats-node-source/node-backend"
STAGE = HOME / ".local/share/talaeats-node-native"
BIN = HOME / ".local/postgresql-15.19/bin"
NODE = HOME / ".local/node24/bin/node"
PM2 = HOME / ".local/lib/node_modules/pm2/bin/pm2"
ENVFILE = HOME / ".config/talaeats-node-staging.env"
BACKUPS = STAGE / "backups"
UNITS = ("tala-node-stage-pg15.service", "tala-node-stage-redis.service",
         "tala-node-stage-pm2.service")
APPS = {"tala-node-stage-api", "tala-node-stage-worker"}
APPROVAL = "I_APPROVE_STAGE_ONLY_SYSTEMD_CUTOVER"


def env() -> dict[str, str]:
    d = dict(os.environ)
    d["HOME"] = str(HOME)
    d["PM2_HOME"] = str(HOME / ".pm2")
    d["PATH"] = f"{HOME}/.local/node24/bin:{HOME}/.local/bin:/usr/bin:/bin"
    d["XDG_RUNTIME_DIR"] = f"/run/user/{os.geteuid()}"
    d["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={d['XDG_RUNTIME_DIR']}/bus"
    return d


def run(args: list[str], *, environment: dict[str, str] | None = None,
        timeout: int = 30) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            args, env=environment or env(), text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False, timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def good(args: list[str], **kw: object) -> bool:
    r = run(args, **kw)
    return bool(r and r.returncode == 0)


def user_ok() -> bool:
    try:
        p = pwd.getpwuid(os.geteuid())
        return (os.geteuid() != 0 and p.pw_name == "tala-node-stage"
                and p.pw_dir == str(HOME) and HOME.is_dir())
    except (OSError, KeyError):
        return False


def config_ok() -> bool:
    try:
        if (ENVFILE.is_symlink() or ENVFILE.stat().st_uid != os.geteuid()
                or stat.S_IMODE(ENVFILE.stat().st_mode) != 0o600):
            return False
        values = dict(line.split("=", 1) for line in ENVFILE.read_text().splitlines()
                      if "=" in line and not line.startswith("#"))
        db = urlsplit(values.get("DATABASE_URL", ""))
        redis = urlsplit(values.get("REDIS_URL", ""))
        return (
            values.get("NODE_ENV") == "staging" and
            values.get("STRIPE_FINANCIAL_WRITES_ENABLED") == "false" and
            db.scheme in ("postgresql", "postgres") and
            db.hostname == "127.0.0.1" and db.port == 15435 and
            unquote(db.username or "") == "tala_node_stage" and
            db.path == "/tala_node_stage" and bool(db.password) and
            redis.scheme == "redis" and redis.hostname == "127.0.0.1" and
            redis.port == 16379 and redis.path == "/0" and bool(redis.password)
        )
    except (OSError, ValueError, TypeError):
        return False


def ready() -> bool:
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:18190/api/v1/ready", timeout=3
        ) as response:
            j = json.loads(response.read(2048))
            return (response.status == 200 and j.get("ready") is True
                    and j.get("database") is True and j.get("redis") is True
                    and j.get("financialWrites") is False)
    except (OSError, ValueError):
        return False


def pm2_stage_only() -> bool:
    p = run([str(NODE), str(PM2), "jlist"], timeout=12)
    if not p or p.returncode != 0:
        return False
    try:
        apps = json.loads(p.stdout)
        return isinstance(apps, list) and len(apps) == 2 and (
            {a.get("name") for a in apps} == APPS and
            all(a.get("pm2_env", {}).get("status") == "online" for a in apps)
        )
    except (ValueError, TypeError):
        return False


def dump_stage_only() -> bool:
    p = HOME / ".pm2/dump.pm2"
    try:
        if p.is_symlink() or p.stat().st_uid != os.geteuid():
            return False
        jobs = json.loads(p.read_text())
        return isinstance(jobs, list) and len(jobs) == 2 and {
            j.get("name") for j in jobs} == APPS
    except (OSError, ValueError, TypeError):
        return False


def backup_exists() -> bool:
    try:
        if BACKUPS.is_symlink() or not BACKUPS.is_dir():
            return False
        for p in BACKUPS.glob("pre-user-systemd-*.dump"):
            if p.is_symlink() or p.stat().st_uid != os.geteuid():
                continue
            if stat.S_IMODE(p.stat().st_mode) != 0o600:
                continue
            if p.stat().st_size < 100 or time.time() - p.stat().st_mtime > 86400:
                continue
            if good([str(BIN / "pg_restore"), "--list", str(p)], timeout=25):
                return True
        return False
    except OSError:
        return False


def unit_state(action: str, name: str) -> str:
    p = run(["systemctl", "--user", action, name], timeout=12)
    return p.stdout.strip() if p and p.returncode == 0 else "not-" + action


def ports_closed() -> bool:
    for port in (15435, 16379, 18190):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return False
        except OSError:
            continue
    return True


def redis_auth() -> str | None:
    try:
        values = dict(line.split("=", 1) for line in ENVFILE.read_text().splitlines()
                      if "=" in line and not line.startswith("#"))
        return unquote(urlsplit(values["REDIS_URL"]).password or "")
    except (OSError, KeyError, ValueError):
        return None


def basic_guards() -> bool:
    if not user_ok() or not config_ok():
        print("ABORT_STAGE_USER_OR_CONFIG_GUARD")
        return False
    if not NODE.is_file() or not PM2.is_file() or not (BIN / "pg_ctl").is_file():
        print("ABORT_STAGE_BINARIES")
        return False
    if not ready() or not pm2_stage_only() or not dump_stage_only():
        print("ABORT_STAGE_PM2_OR_READY")
        return False
    if not backup_exists():
        print("ABORT_VERIFIED_STAGE_BACKUP_REQUIRED")
        return False
    if not all(unit_state("is-enabled", n) == "enabled" for n in UNITS):
        print("ABORT_USER_SYSTEMD_UNITS_NOT_ENABLED")
        return False
    if any(unit_state("is-active", n) == "active" for n in UNITS):
        print("ABORT_SYSTEMD_ALREADY_OWNS_SOME_SERVICES")
        return False
    print("STAGE_CUTOVER_PREFLIGHT=PASS")
    return True


def emergency_restore() -> bool:
    # Disables nothing and modifies no host/global service: only the stage units.
    for n in reversed(UNITS):
        run(["systemctl", "--user", "stop", n], timeout=65)
    pgdata = STAGE / "postgres15-data"
    pglog = STAGE / "logs/postgres15.log"
    rediscfg = STAGE / "redis-stage.conf"
    pg_started = good([str(BIN / "pg_ctl"), "-D", str(pgdata),
                       "-l", str(pglog), "-w", "-t", "30", "start"], timeout=40)
    redis_started = good(["redis-server", str(rediscfg)], timeout=20)
    pm_started = good([str(NODE), str(PM2), "resurrect"], timeout=35)
    if pg_started and redis_started and pm_started:
        for _ in range(25):
            if ready() and pm2_stage_only():
                print("STAGE_MANUAL_ROLLBACK=PASS")
                return True
            time.sleep(1)
    print("STAGE_MANUAL_ROLLBACK=FAILED_MANUAL_OPERATOR_REVIEW")
    return False


def main() -> int:
    if sys.argv[1:] not in ([], ["--plan"], ["--apply"]):
        print("USAGE --plan|--apply")
        return 2
    mode = sys.argv[1] if len(sys.argv) == 2 else "--plan"
    print("TALA_STAGE_USER_SYSTEMD_CUTOVER_BEGIN")
    if not basic_guards():
        return 1
    if mode == "--plan":
        print("COLDSTART_CUTOVER_PLAN_NO_MUTATIONS=PASS")
        return 0
    if os.environ.get("TALA_STAGE_CUTOVER_APPROVAL") != APPROVAL:
        print("ABORT_EXPLICIT_STAGE_ONLY_CUTOVER_APPROVAL")
        return 1

    # Transition only the two stage PM2 apps, stage Redis and stage PG15.
    if not good([str(NODE), str(PM2), "kill"], timeout=30):
        print("STAGE_PM2_KILL_FAILED")
        return 1
    print("STAGE_PM2_MANUAL_STOP=PASS")
    rsecret = redis_auth()
    if not rsecret:
        print("ABORT_STAGE_REDIS_AUTH_UNAVAILABLE")
        emergency_restore()
        return 1
    renv = env()
    renv["REDISCLI_AUTH"] = rsecret
    if not good(["redis-cli", "-h", "127.0.0.1", "-p", "16379",
                 "shutdown", "save"], environment=renv, timeout=25):
        print("STAGE_REDIS_STOP_FAILED")
        emergency_restore()
        return 1
    print("STAGE_REDIS_MANUAL_STOP=PASS")
    if not good([str(BIN / "pg_ctl"), "-D", str(STAGE / "postgres15-data"),
                 "-m", "fast", "-w", "-t", "45", "stop"], timeout=55):
        print("STAGE_PG15_STOP_FAILED")
        emergency_restore()
        return 1
    print("STAGE_PG15_MANUAL_STOP=PASS")
    for _ in range(18):
        if ports_closed():
            break
        time.sleep(0.5)
    if not ports_closed():
        print("STAGE_OLD_PORTS_NOT_RELEASED")
        emergency_restore()
        return 1
    print("STAGE_MANUAL_PORTS_RELEASED=PASS")
    # Requires brings up only PG15 and Redis stage units, then PM2 stage unit.
    started = good(["systemctl", "--user", "start", UNITS[-1]], timeout=130)
    healthy = (started and all(
        unit_state("is-active", n) == "active" for n in UNITS)
        and ready() and pm2_stage_only())
    if healthy:
        print("STAGE_PG_REDIS_PM2_SYSTEMD_ACTIVE=PASS")
        print("STAGE_API_WORKER_READY_AFTER_COLDSTART=PASS")
        print("NO_PRODUCTION_HOST_CHANGES=yes")
        return 0
    print("STAGE_SYSTEMD_START_FAILED_TRYING_STAGE_ONLY_ROLLBACK")
    emergency_restore()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
