#!/usr/bin/env python3
"""PG15 staging-only logical backup prior to changing native service ownership.

--plan: read-only; --apply: explicitly approved backup only.
Passwords never appear in argv, console output or git.
"""
from __future__ import annotations
import datetime as dt
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit

USER = "tala-node-stage"
HOME = Path("/home/tala-node-stage")
ENV = HOME / ".config/talaeats-node-staging.env"
BIN = HOME / ".local/postgresql-15.19/bin"
BACKUP_DIR = HOME / ".local/share/talaeats-node-native/backups"
APPROVAL = "I_APPROVE_STAGE_DB_BACKUP_ONLY"


def env_values() -> dict[str, str] | None:
    try:
        if ENV.is_symlink() or stat.S_IMODE(ENV.stat().st_mode) != 0o600:
            return None
        if ENV.stat().st_uid != os.geteuid():
            return None
        obj = {}
        for line in ENV.read_text().splitlines():
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                obj[k] = v
        return obj
    except OSError:
        return None


def expected_target(values: dict[str, str]) -> tuple[str, str] | None:
    try:
        url = urlsplit(values.get("DATABASE_URL", ""))
        if not (
            values.get("NODE_ENV") == "staging"
            and values.get("STRIPE_FINANCIAL_WRITES_ENABLED") == "false"
            and url.scheme in ("postgres", "postgresql")
            and url.hostname == "127.0.0.1" and url.port == 15435
            and unquote(url.username or "") == "tala_node_stage"
            and url.path == "/tala_node_stage"
            and bool(url.password)
        ):
            return None
        return unquote(url.username or ""), unquote(url.password or "")
    except (ValueError, TypeError):
        return None


def run(args: list[str], env: dict[str, str] | None = None, timeout: int = 30) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(args, capture_output=True, text=True,
                              env=env, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None


def main() -> int:
    if sys.argv[1:] not in ([], ["--plan"], ["--apply"]):
        print("USAGE --plan|--apply")
        return 2
    mode = sys.argv[1] if len(sys.argv) > 1 else "--plan"
    print("TALA_STAGE_PG_BACKUP_BEGIN")
    if (os.geteuid() == 0 or
        pwd.getpwuid(os.geteuid()).pw_name != USER or
        not HOME.is_dir() or HOME.is_symlink()):
        print("ABORT_STAGE_USER_ONLY")
        return 1
    values = env_values()
    target = expected_target(values) if values else None
    if not target:
        print("ABORT_STAGING_PG_TARGET_GUARD")
        return 1
    for prog in ("pg_dump", "pg_restore", "psql"):
        if not (BIN / prog).is_file():
            print("ABORT_STAGING_PG_BINARY")
            return 1
    if BACKUP_DIR.is_symlink() or (BACKUP_DIR.exists() and
       (not BACKUP_DIR.is_dir() or BACKUP_DIR.stat().st_uid != os.geteuid())):
        print("ABORT_BACKUP_PATH_UNSAFE")
        return 1
    if BACKUP_DIR.exists() and stat.S_IMODE(BACKUP_DIR.stat().st_mode) != 0o700:
        print("ABORT_BACKUP_DIR_PERMISSIONS")
        return 1
    runtime_env = dict(os.environ)
    runtime_env["PGPASSWORD"] = target[1]
    runtime_env["PGCONNECT_TIMEOUT"] = "5"
    args = [str(BIN / "psql"), "-h", "127.0.0.1", "-p", "15435",
            "-U", target[0], "-d", "tala_node_stage",
            "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
            "-c", ("SELECT current_database(), current_user, "
                   "current_setting('server_version_num')::int, inet_server_port()")]
    q = run(args, runtime_env)
    if not q or q.returncode != 0 or not re.fullmatch(
        r"tala_node_stage\|tala_node_stage\|15[0-9]{4}\|15435", q.stdout.strip()
    ):
        print("ABORT_PG15_STAGE_SERVER_IDENTITY")
        return 1
    print("PG15_LOCAL_IDENTITY=PASS")
    if mode == "--plan":
        print("STAGE_BACKUP_PLAN_ONLY_NO_CHANGES=PASS")
        return 0
    if os.environ.get("TALA_STAGE_BACKUP_APPROVAL") != APPROVAL:
        print("ABORT_EXPLICIT_BACKUP_APPROVAL")
        return 1
    try:
        BACKUP_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, pathname = tempfile.mkstemp(
            prefix="pre-user-systemd-", suffix=".dump", dir=BACKUP_DIR)
        os.close(fd)
        path = Path(pathname)
        dump = run([str(BIN / "pg_dump"), "-h", "127.0.0.1",
                    "-p", "15435", "-U", target[0], "-d", "tala_node_stage",
                    "--no-password", "-Fc", "-f", str(path)],
                   runtime_env, timeout=90)
        if not dump or dump.returncode != 0 or path.stat().st_size < 100:
            path.unlink(missing_ok=True)
            print("ABORT_STAGING_BACKUP_FAILED")
            return 1
        listing = run([str(BIN / "pg_restore"), "--list", str(path)], timeout=30)
        if not listing or listing.returncode != 0:
            path.unlink(missing_ok=True)
            print("ABORT_STAGING_ARCHIVE_LIST_FAILED")
            return 1
        print("PG15_STAGE_BACKUP_ARCHIVE=PASS")
        print("PG15_STAGE_ARCHIVE_LIST=PASS")
        print("PG15_STAGE_BACKUP_MODE_0600=" +
              ("PASS" if stat.S_IMODE(path.stat().st_mode) == 0o600 else "FAIL"))
        print("BACKUP_IN_STAGE_HOME_ONLY=PASS")
        print("STAGE_BACKUP_FILE_NAME=" + path.name)
        print("BACKUP_NOT_FULL_RESTORE_TEST=yes")
        return 0
    except (OSError, ValueError):
        print("ABORT_STAGING_BACKUP_IO")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
