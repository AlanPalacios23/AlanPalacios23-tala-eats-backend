#!/usr/bin/env python3
"""Restore latest verified TALA staging PG15 dump into an ephemeral socket-only cluster.

--plan performs checks only; --apply creates a private ephemeral PostgreSQL 15.19
instance in stage HOME, restores dump, checks schema and migration, shuts down,
and removes only the ephemeral temp dir. Never uses a TCP port/public listener.
"""
from __future__ import annotations
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

USER = "tala-node-stage"
HOME = Path("/home/tala-node-stage")
ROOT = HOME / ".local/share/talaeats-node-native"
BACKUPS = ROOT / "backups"
BIN = HOME / ".local/postgresql-15.19/bin"
PORT = "15436"  # local socket-only; no TCP listener
ADMIN = "tala_restore_scratch"
DB = "tala_restore_check"
APPROVAL = "I_APPROVE_ISOLATED_STAGING_RESTORE_TEST"


def exec_cmd(args: list[str], *, timeout: int = 45) -> tuple[bool, str]:
    try:
        r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           text=True, check=False, timeout=timeout)
        return r.returncode == 0, r.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return False, ""


def stage_user() -> bool:
    try:
        p = pwd.getpwuid(os.geteuid())
        return os.geteuid() != 0 and p.pw_name == USER and p.pw_dir == str(HOME)
    except (OSError, KeyError):
        return False


def backups_safe() -> list[Path]:
    if BACKUPS.is_symlink() or not BACKUPS.is_dir() or (
        BACKUPS.stat().st_uid != os.geteuid()
        or stat.S_IMODE(BACKUPS.stat().st_mode) != 0o700
    ):
        return []
    result = []
    for p in BACKUPS.glob("pre-user-systemd-*.dump"):
        try:
            s = p.lstat()
            if (not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid()
                or stat.S_IMODE(s.st_mode) != 0o600 or s.st_size < 100):
                continue
            result.append(p)
        except OSError:
            continue
    return sorted(result, key=lambda x: x.stat().st_mtime, reverse=True)


def pg15_bins() -> bool:
    for name in ("initdb", "pg_ctl", "postgres", "createdb",
                 "pg_restore", "psql"):
        if not (BIN / name).is_file():
            return False
    ok, output = exec_cmd([str(BIN / "postgres"), "--version"], timeout=5)
    return ok and "15.19" in output


def source_unchanged() -> bool:
    # Only read source's readiness, never connect to stage database or any
    # production containers during restore.
    ok, out = exec_cmd(["/usr/bin/curl", "-fsS", "--max-time", "4",
                        "http://127.0.0.1:18190/api/v1/ready"], timeout=8)
    return ok and '"ready":true' in out and '"financialWrites":false' in out


def main() -> int:
    if sys.argv[1:] not in ([], ["--plan"], ["--apply"]):
        print("USAGE --plan|--apply")
        return 2
    mode = sys.argv[1] if len(sys.argv) == 2 else "--plan"
    print("TALA_STAGE_PG15_ISOLATED_RESTORE_BEGIN")
    if not stage_user() or not ROOT.is_dir() or ROOT.is_symlink() or not pg15_bins():
        print("ABORT_STAGING_IDENTITY_OR_PG15_BINARIES")
        return 1
    candidates = backups_safe()
    if not candidates:
        print("ABORT_PRIVATE_STAGING_BACKUP_MISSING")
        return 1
    src = candidates[0]
    valid, _ = exec_cmd([str(BIN / "pg_restore"), "--list", str(src)], timeout=20)
    if not valid:
        print("ABORT_PG_RESTORE_ARCHIVE_INVALID")
        return 1
    print("STAGING_BACKUP_ARCHIVE_VALID=PASS")
    if not source_unchanged():
        print("ABORT_SOURCE_STAGING_API_NOT_READY")
        return 1
    print("STAGING_SOURCE_READY=PASS")
    if mode == "--plan":
        print("ISOLATED_RESTORE_PLAN_NO_CHANGES=PASS")
        return 0
    if os.environ.get("TALA_STAGE_RESTORE_APPROVAL") != APPROVAL:
        print("ABORT_EXPLICIT_RESTORE_APPROVAL")
        return 1

    scratch: Path | None = None
    started = False
    result = False
    try:
        # Temp dir mode 0700, socket-only, no password or network listener.
        scratch = Path(tempfile.mkdtemp(prefix="tala-pg15-restore-",
                                        dir=ROOT))
        data = scratch / "data"
        sock = scratch / "socket"
        sock.mkdir(mode=0o700)
        logfile = scratch / "postgres.log"
        ok, _ = exec_cmd([
            str(BIN / "initdb"), "-D", str(data), "-U", ADMIN,
            "--encoding=UTF8", "--locale=C",
            "--auth-local=trust", "--auth-host=reject",
            "--no-instructions",
        ], timeout=100)
        if not ok:
            print("SCRATCH_INITDB=FAIL")
            return 1
        with (data / "postgresql.conf").open("a") as f:
            f.write("\n# isolated test: NO TCP listener\n")
            f.write("listen_addresses = ''\n")
            f.write(f"port = {PORT}\n")
            f.write(f"unix_socket_directories = '{sock}'\n")
            f.write("unix_socket_permissions = 0700\n")
            f.write("ssl = off\nmax_connections = 12\n")
            f.write("shared_buffers = 32MB\n")
        ok, _ = exec_cmd([str(BIN / "pg_ctl"), "-D", str(data),
                          "-l", str(logfile), "-w", "-t", "30", "start"],
                         timeout=48)
        if not ok:
            print("SCRATCH_START=FAIL")
            return 1
        started = True
        print("SCRATCH_SOCKET_ONLY_POSTGRES_READY=PASS")
        shared = ["-h", str(sock), "-p", PORT, "-U", ADMIN]
        ok, _ = exec_cmd([str(BIN / "createdb"), *shared, DB], timeout=15)
        if not ok:
            print("SCRATCH_CREATE_DB=FAIL")
            return 1
        ok, _ = exec_cmd([
            str(BIN / "pg_restore"), *shared, "--no-owner", "--no-acl",
            "--exit-on-error", "--single-transaction", "-d", DB, str(src),
        ], timeout=100)
        if not ok:
            print("SCRATCH_FULL_RESTORE=FAIL")
            return 1
        query = ("SELECT ("
                 "(SELECT count(*) FROM information_schema.tables "
                 " WHERE table_schema='public' AND table_name IN "
                 "('stripe_webhook_events','merchant_connect_accounts',"
                 "'payout_instructions')) = 3) AND "
                 "(EXISTS(SELECT 1 FROM public._prisma_migrations "
                 "WHERE migration_name='20261019_initial'))")
        ok, out = exec_cmd([str(BIN / "psql"), *shared, "-d", DB,
                            "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
                            "-c", query], timeout=18)
        result = bool(ok and out == "t")
        print("SCRATCH_SCHEMA_AND_MIGRATION=" + ("PASS" if result else "FAIL"))
        if result:
            print("SCRATCH_FULL_RESTORE=PASS")
        return 0 if result else 1
    except (OSError, ValueError):
        print("SCRATCH_RESTORE_IO=FAIL")
        return 1
    finally:
        if scratch:
            if started:
                exec_cmd([str(BIN / "pg_ctl"), "-D", str(scratch / "data"),
                          "-m", "immediate", "-w", "-t", "20", "stop"],
                         timeout=35)
            # Fail closed: never remove PGDATA if scratch server may run.
            if not started or not (scratch / "data/postmaster.pid").exists():
                shutil.rmtree(scratch, ignore_errors=False)
                print("SCRATCH_CONTAINERLESS_CLEANUP=PASS")
            else:
                print("SCRATCH_NOT_REMOVED_SERVER_MAY_BE_RUNNING")
        print("NO_LIVE_PRODUCTION_PG18_DOCKER_STRIPE_OPERATIONS=yes")
        print("TALA_STAGE_PG15_ISOLATED_RESTORE_END")


if __name__ == "__main__":
    raise SystemExit(main())
