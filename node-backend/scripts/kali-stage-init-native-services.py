#!/usr/bin/env python3
"""Provision ONLY native PostgreSQL 15.19 + Redis 8 for TALA Node staging.

--plan is read-only. --apply is stage-user only with an explicit approval env.
Does not call apt/sudo/Docker, touch PG18/main or the existing Redis service,
bind a public interface, migrate the database, or start Node/PM2.
"""
from __future__ import annotations

import getpass
import os
from pathlib import Path
import pwd
import re
import secrets
import socket
import stat
import subprocess
import sys
import time

STAGE_USER = "tala-node-stage"
PG_PORT = 15435
REDIS_PORT = 16379
API_PORT = 18190
PG_APP_USER = "tala_node_stage"
PG_APP_DB = "tala_node_stage"
PG_ADMIN_USER = "stage_pg_admin"
APPROVAL = "I_APPROVE_ISOLATED_PG15_REDIS_ONLY"
HOME = Path("/home/tala-node-stage")
BASE = HOME / ".local/share/talaeats-node-native"
PG_BIN = HOME / ".local/postgresql-15.19/bin"
PG_DATA = BASE / "postgres15-data"
PG_SOCKET = BASE / "run"
PG_LOG = BASE / "logs/postgres15.log"
REDIS_DATA = BASE / "redis-data"
REDIS_CONF = BASE / "redis-stage.conf"
REDIS_LOG = BASE / "logs/redis-stage.log"
REDIS_PID = BASE / "redis-stage.pid"
ADMIN_PASS_FILE = HOME / ".config/talaeats-native-pg15-admin.secret"
ENV_FILE = HOME / ".config/talaeats-node-staging.env"


def emit(k: str, value: str) -> None:
    print(f"{k}={value}", flush=True)


def safe_run(args: list[str], *, stdin: str | None = None,
             env: dict[str, str] | None = None, timeout: int = 35) -> bool:
    try:
        r = subprocess.run(args, input=stdin, text=True, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout, check=False)
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def output(args: list[str], *, env: dict[str, str] | None = None,
           timeout: int = 12) -> str | None:
    try:
        r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           text=True, env=env, timeout=timeout, check=False)
        return r.stdout.strip() if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def port_free(port: int) -> bool:
    # Test the exact intended loopback bind; no open sockets persist.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", port))
            return True
    except OSError:
        return False


def check_identity() -> bool:
    try:
        return (os.getuid() != 0 and getpass.getuser() == STAGE_USER
                and pwd.getpwuid(os.getuid()).pw_dir == str(HOME)
                and HOME.is_dir() and HOME.resolve() == HOME
                and stat.S_IMODE(HOME.stat().st_mode) == 0o700
                and not set(os.getgroups()).intersection(
                    {g.gr_gid for g in __import__("grp").getgrall()
                     if g.gr_name in {"docker", "sudo", "adm", "root"}}))
    except (OSError, KeyError, ValueError):
        return False


def check_tools() -> bool:
    pgv = output([str(PG_BIN / "postgres"), "--version"])
    initv = output([str(PG_BIN / "initdb"), "--version"])
    redisv = output(["redis-server", "--version"])
    pg_ok = bool(pgv and initv and "15.19" in pgv and "15.19" in initv)
    redis_ok = bool(redisv and re.search(r"v=8[.]", redisv))
    emit("POSTGRES15_19_HOME_BINARY", "PASS" if pg_ok else "FAIL")
    emit("REDIS8_NATIVE_BINARY", "PASS" if redis_ok else "FAIL")
    return pg_ok and redis_ok and (PG_BIN / "psql").is_file() and (PG_BIN / "pg_ctl").is_file()


def check_empty() -> bool:
    targets = [BASE, PG_DATA, REDIS_CONF, ENV_FILE, ADMIN_PASS_FILE]
    no_collision = True
    for p in targets:
        if p.exists() or p.is_symlink():
            no_collision = False
    emit("STAGE_CONFIG_NEW", "yes" if no_collision else "no")
    for port in (PG_PORT, REDIS_PORT, API_PORT):
        is_free = port_free(port)
        emit(f"PORT_{port}", "free" if is_free else "occupied")
        if not is_free:
            no_collision = False
    return no_collision


def check_resources() -> bool:
    try:
        fs = os.statvfs(HOME)
        free_bytes = fs.f_bavail * fs.f_frsize
        ok = free_bytes >= 1024 * 1024 * 1024
        emit("FREE_SPACE_GTE_1GB", "yes" if ok else "no")
        return ok
    except OSError:
        emit("FREE_SPACE_GTE_1GB", "unknown")
        return False


def mkdir(p: Path) -> None:
    p.mkdir(mode=0o700, parents=True, exist_ok=False)


def private_file(p: Path, value: str) -> None:
    fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(value)
        f.flush()
        os.fsync(f.fileno())


def psql(admin_pass: str, sql: str) -> bool:
    env = dict(os.environ)
    env["PGPASSWORD"] = admin_pass
    env["PGCONNECT_TIMEOUT"] = "5"
    return safe_run([str(PG_BIN / "psql"), "-h", str(PG_SOCKET), "-p",
                     str(PG_PORT), "-U", PG_ADMIN_USER, "-d", "postgres",
                     "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                    stdin=sql, env=env)


def pg_app_test(app_pass: str) -> bool:
    env = dict(os.environ)
    env["PGPASSWORD"] = app_pass
    env["PGCONNECT_TIMEOUT"] = "5"
    statement = ("SELECT current_database(), current_user, "
                 "current_setting('server_version_num')::int, inet_server_port()")
    value = output([str(PG_BIN / "psql"), "-h", "127.0.0.1",
                    "-p", str(PG_PORT), "-U", PG_APP_USER, "-d", PG_APP_DB,
                    "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
                    "-c", statement], env=env)
    if not value:
        return False
    parts = value.split("|")
    return (len(parts) == 4 and parts[0] == PG_APP_DB and
            parts[1] == PG_APP_USER and parts[2].isdigit()
            and 150000 <= int(parts[2]) < 160000 and parts[3] == str(PG_PORT))


def redis_test(secret: str) -> bool:
    env = dict(os.environ)
    env["REDISCLI_AUTH"] = secret
    for _ in range(12):
        r = output(["redis-cli", "-h", "127.0.0.1", "-p", str(REDIS_PORT),
                    "ping"], env=env, timeout=3)
        if r == "PONG":
            return True
        time.sleep(1)
    return False


def install() -> None:
    os.umask(0o077)
    mkdir(BASE)
    for p in (PG_SOCKET, PG_LOG.parent, REDIS_DATA):
        mkdir(p)
    cfg = HOME / ".config"
    if not cfg.is_dir() or cfg.is_symlink() or stat.S_IMODE(cfg.stat().st_mode) != 0o700:
        raise RuntimeError("STAGE_CONFIG_DIRECTORY_UNSAFE")

    admin_secret = secrets.token_hex(32)
    pg_secret = secrets.token_hex(32)
    redis_secret = secrets.token_hex(32)
    private_file(ADMIN_PASS_FILE, admin_secret + "\n")
    # Password stdin is temporary, never passed in argv or terminal output.
    init_pw = BASE / ".initial-pg-password"
    private_file(init_pw, admin_secret + "\n")
    try:
        initialized = safe_run(
            [str(PG_BIN / "initdb"), "-D", str(PG_DATA),
             "-U", PG_ADMIN_USER, "--encoding=UTF8", "--locale=C",
             "--auth-local=scram-sha-256", "--auth-host=scram-sha-256",
             "--pwfile=" + str(init_pw), "--no-instructions"], timeout=100)
    finally:
        init_pw.unlink(missing_ok=True)
    if not initialized:
        raise RuntimeError("PG_INITDB_FAILED")
    emit("PG15_INITDB", "PASS")

    conf = PG_DATA / "postgresql.conf"
    with conf.open("a", encoding="utf-8") as f:
        f.write("\n# TALA NATIVE STAGING LOCAL ONLY\n")
        f.write("listen_addresses = '127.0.0.1'\n")
        f.write(f"port = {PG_PORT}\n")
        f.write(f"unix_socket_directories = '{PG_SOCKET}'\n")
        f.write("unix_socket_permissions = 0700\n")
        f.write("ssl = off\npassword_encryption = 'scram-sha-256'\n")
        f.write("max_connections = 30\nshared_buffers = 64MB\n")
        f.write("work_mem = 4MB\nlogging_collector = off\n")
        f.write("log_statement = 'none'\nlog_min_error_statement = panic\n")
    # Prevent logs from exposing secrets; logs are private and are not printed.
    private_file(PG_LOG, "")
    if not safe_run([str(PG_BIN / "pg_ctl"), "-D", str(PG_DATA),
                     "-l", str(PG_LOG), "-w", "-t", "30", "start"], timeout=45):
        raise RuntimeError("PG_START_FAILED")
    emit("PG15_LOOPBACK_START", "PASS")

    if not psql(admin_secret, "CREATE ROLE tala_node_stage WITH LOGIN "
                f"PASSWORD '{pg_secret}' NOSUPERUSER NOCREATEDB "
                "NOCREATEROLE NOREPLICATION;\n"):
        raise RuntimeError("PG_APP_ROLE_FAILED")
    if not psql(admin_secret, "CREATE DATABASE tala_node_stage OWNER tala_node_stage;\n"):
        raise RuntimeError("PG_APP_DATABASE_FAILED")
    if not pg_app_test(pg_secret):
        raise RuntimeError("PG_APP_AUTH_IDENTITY_FAILED")
    emit("PG15_APP_AUTH_SELECT", "PASS")

    private_file(REDIS_LOG, "")
    redis_config = (
        "bind 127.0.0.1\n"
        f"port {REDIS_PORT}\n"
        "protected-mode yes\n"
        f"requirepass {redis_secret}\n"
        "daemonize yes\nsupervised no\n"
        f"pidfile {REDIS_PID}\n"
        f"dir {REDIS_DATA}\n"
        f"logfile {REDIS_LOG}\n"
        "appendonly yes\nappendfsync everysec\n"
        "maxmemory 128mb\nmaxmemory-policy noeviction\n"
    )
    private_file(REDIS_CONF, redis_config)
    if not safe_run(["redis-server", str(REDIS_CONF)], timeout=20):
        raise RuntimeError("REDIS_START_FAILED")
    if not redis_test(redis_secret):
        raise RuntimeError("REDIS_APP_AUTH_FAILED")
    emit("REDIS8_STAGE_AUTH_PING", "PASS")

    env_value = (
        "NODE_ENV=staging\nHOST=127.0.0.1\nPORT=18190\n"
        f"DATABASE_URL=postgresql://{PG_APP_USER}:{pg_secret}@127.0.0.1:"
        f"{PG_PORT}/{PG_APP_DB}\n"
        f"REDIS_URL=redis://:{redis_secret}@127.0.0.1:{REDIS_PORT}/0\n"
        "STRIPE_FINANCIAL_WRITES_ENABLED=false\n"
    )
    private_file(ENV_FILE, env_value)
    emit("STAGING_PRIVATE_ENV_0600", "PASS")
    emit("STAGING_PG15_REDIS_READY", "PASS")


def main() -> int:
    # argparse interprets --plan as an option; map to a plain token.
    raw = sys.argv[1:]
    if raw not in ([], ["--plan"], ["--apply"]):
        print("USAGE: python3 kali-stage-init-native-services.py --plan|--apply")
        return 2
    mode = raw[0] if raw else "--plan"
    emit("TALA_NODE_NATIVE_INIT_BEGIN", "1")
    if not check_identity():
        emit("ABORT", "WRONG_STAGE_USER_OR_HOME")
        return 1
    ok = check_tools()
    ok = check_empty() and ok
    ok = check_resources() and ok
    if not ok:
        emit("ABORT", "NATIVE_STAGE_PREFLIGHT_FAILED")
        return 1
    if mode == "--plan":
        emit("PLAN_ONLY_NO_MUTATIONS", "yes")
        emit("TALA_NODE_NATIVE_INIT_END", "1")
        return 0
    if os.environ.get("TALA_STAGE_SERVICES_APPROVAL") != APPROVAL:
        emit("ABORT", "EXPLICIT_STAGE_SERVICES_APPROVAL_REQUIRED")
        return 1
    try:
        install()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        # Do not print raw exceptions or service logs; they may include secrets.
        code = str(exc) if isinstance(exc, RuntimeError) else "STAGE_INITIALIZATION_ERROR"
        if not re.fullmatch(r"[A-Z0-9_]+", code):
            code = "STAGE_INITIALIZATION_ERROR"
        emit("STAGING_INSTALL", "PARTIAL_OR_FAILED")
        emit("BLOCKER", code)
        emit("DO_NOT_RERUN_APPLY", "yes")
        return 1
    emit("LIVE_DOCKER_PG18_AND_STRIPE_UNTOUCHED", "yes")
    emit("TALA_NODE_NATIVE_INIT_END", "1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
