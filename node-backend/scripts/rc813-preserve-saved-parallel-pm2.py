#!/usr/bin/env python3
"""Inspect and optionally archive an *inactive* RC8.13 parallel PM2_HOME.

Never invokes PM2. Never removes any files, modifies default PM2, databases,
payment configuration, Cloudflared, or starts/stops processes.
Output contains only statuses and a path, no dump JSON or env contents.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import subprocess
import sys

OWNER = "tala-node-stage"
ROOT = Path("/home/tala-node-stage")
HOME = ROOT / ".pm2-tala-rc813-parallel"
PREFIX = ROOT / "tala-node-releases"
EXPECTED = {
    "tala-rc813-parallel-api": "dist/server.js",
    "tala-rc813-parallel-worker": "dist/worker.js",
}
ACK = "I_APPROVE_ARCHIVE_RC813_PM2_ONLY"


def fail(reason: str) -> None:
    print("RC813_PM2_ARCHIVE_HOLD=" + reason, flush=True)
    raise SystemExit(1)


def is_owner_regular(path: Path) -> bool:
    try:
        s = path.lstat()
        return stat.S_ISREG(s.st_mode) and s.st_uid == os.geteuid()
    except OSError:
        return False


def validate_dump(path: Path) -> None:
    if not is_owner_regular(path):
        fail("DUMP_NOT_OWNER_REGULAR")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        fail("DUMP_INVALID_JSON")
    if not isinstance(data, list) or len(data) != 2:
        fail("DUMP_EXPECTED_EXACTLY_TWO")
    names = set()
    for entry in data:
        if not isinstance(entry, dict):
            fail("DUMP_INVALID_ENTRY")
        settings = entry.get("pm2_env") if isinstance(entry.get("pm2_env"), dict) else entry
        name = entry.get("name") or settings.get("name")
        if name not in EXPECTED or name in names:
            fail("DUMP_UNKNOWN_OR_DUPLICATE_APP")
        names.add(name)
        exec_path = settings.get("pm_exec_path") or entry.get("pm_exec_path")
        cwd = settings.get("pm_cwd") or entry.get("pm_cwd")
        if not isinstance(exec_path, str) or not isinstance(cwd, str):
            fail("DUMP_MISSING_EXEC_IDENTITY")
        # Prevent a copied LIVE/default PM2 dump from being archived.
        allowed = re.fullmatch(
            r"/home/tala-node-stage/tala-node-releases/[a-f0-9]{40}/node-backend",
            cwd,
        )
        if not allowed or exec_path != cwd + "/" + EXPECTED[name]:
            fail("DUMP_UNEXPECTED_EXEC_PATH")
        env = settings.get("env") if isinstance(settings.get("env"), dict) else {}
        node_env = env.get("NODE_ENV", settings.get("NODE_ENV"))
        if node_env is not None and node_env != "staging":
            fail("DUMP_NOT_STAGING")
    if names != set(EXPECTED):
        fail("DUMP_DIFFERENT_APP_SET")


def has_listening_port() -> bool:
    # ss may show a listener on IPv4 wildcard or IPv6; do not rely on a
    # connect() failure to prove it is unbound.
    try:
        p = subprocess.run(
            ["ss", "-lntH"], check=True, text=True, capture_output=True, timeout=5
        )
    except (OSError, subprocess.SubprocessError):
        fail("CANNOT_VERIFY_PORT")
    for line in p.stdout.splitlines():
        parts = line.split()
        if len(parts) > 3 and re.search(r"(?:^|:)18192$", parts[3]):
            return True
    return False


def check_inactive() -> None:
    pid_file = HOME / "pm2.pid"
    if pid_file.exists() or pid_file.is_symlink():
        if not is_owner_regular(pid_file):
            fail("UNEXPECTED_PM2_PID_FILE")
        try:
            pid_text = pid_file.read_text().strip()
            if not re.fullmatch(r"[0-9]{1,9}", pid_text):
                fail("INVALID_PM2_PID")
            pid = int(pid_text)
            os.kill(pid, 0)
        except ProcessLookupError:
            pass
        except PermissionError:
            fail("PM2_PID_EXISTS_CANNOT_VALIDATE")
        except OSError:
            fail("PM2_PID_CHECK_ERROR")
        else:
            fail("PM2_PID_STILL_ALIVE")
    try:
        p = subprocess.run(
            ["ps", "-u", OWNER, "-o", "args="],
            capture_output=True, text=True, check=True, timeout=5
        )
    except (OSError, subprocess.SubprocessError):
        fail("CANNOT_VERIFY_PROCESSES")
    for args in p.stdout.splitlines():
        if (
            ("God Daemon (" in args and str(HOME) in args)
            or "tala-rc813-parallel-api" in args
            or "tala-rc813-parallel-worker" in args
        ):
            fail("PARALLEL_DAEMON_OR_APP_STILL_RUNNING")
    if has_listening_port():
        fail("PORT_18192_OCCUPIED")


def check_tree() -> None:
    if HOME.is_symlink() or not HOME.is_dir() or HOME.lstat().st_uid != os.geteuid():
        fail("UNEXPECTED_PM2_HOME")
    if not stat.S_ISDIR(HOME.lstat().st_mode):
        fail("PM2_HOME_NOT_DIRECTORY")
    # Reject any external symlink; never move a directory with unexpected links.
    for root, dirs, files in os.walk(HOME, followlinks=False):
        for item in dirs + files:
            if (Path(root) / item).is_symlink():
                fail("SYMLINK_IN_PM2_HOME")
    validate_dump(HOME / "dump.pm2")
    alternate = HOME / "dump.pm2.bak"
    if alternate.exists() or alternate.is_symlink():
        validate_dump(alternate)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["--plan", "--archive"])
    parser.add_argument("approval", nargs="?")
    # Explicit flags are easy to confuse with argparse options.
    args = sys.argv[1:]
    if not args or args[0] not in ("--plan", "--archive"):
        fail("USAGE_PLAN_OR_ARCHIVE")
    mode = args[0]
    if mode == "--plan" and len(args) != 1:
        fail("PLAN_NO_EXTRA_ARGUMENTS")
    if mode == "--archive" and (len(args) != 2 or args[1] != ACK):
        fail("EXPLICIT_APPROVAL_REQUIRED")
    if os.geteuid() == 0 or pwd.getpwuid(os.geteuid()).pw_name != OWNER:
        fail("RUN_AS_STAGE_USER")
    if not HOME.exists() and not HOME.is_symlink():
        print("RC813_PM2_RESIDUE=ABSENT")
        return 0
    check_tree()
    check_inactive()
    print("RC813_PM2_DUMP_EXPECTED_TWO=PASS")
    print("RC813_PM2_PARALLEL_INACTIVE=PASS")
    print("RC813_LIVE_PORT_18190_NOT_TOUCHED=YES")
    if mode == "--plan":
        print("RC813_PM2_ARCHIVE_PLAN_READ_ONLY=PASS")
        return 0
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = ROOT / f".pm2-tala-rc813-parallel.saved-{stamp}-{os.getpid()}"
    if destination.exists() or destination.is_symlink():
        fail("ARCHIVE_PATH_ALREADY_EXISTS")
    # Same parent filesystem: atomic rename, retaining every file including
    # the two saved process definitions. No rm / chmod / pm2 commands.
    os.rename(HOME, destination)
    print("RC813_PM2_SAVED_BACKUP_ARCHIVED=PASS")
    print("RC813_PM2_ARCHIVE_LOCATION=" + str(destination))
    print("RC813_LIVE_PM2_STRIPE_DB_UNMODIFIED=YES")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
