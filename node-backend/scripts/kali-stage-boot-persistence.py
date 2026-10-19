#!/usr/bin/env python3
"""Stage-user-only prepare boot recovery. --plan never changes the host.

--apply saves ONLY two verified stage PM2 apps then installs/enables ONLY
three user systemd units. It never starts/stops services or reboots Kali.
Before --apply, systemd lingering must be explicitly enabled by the admin.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import stat
import subprocess
import sys
import urllib.request

USER = "tala-node-stage"
HOME = Path("/home/tala-node-stage")
ROOT = HOME / "talaeats-node-source/node-backend"
TEMPLATES = ROOT / "ops/systemd"
DEST = HOME / ".config/systemd/user"
UNITS = (
    "tala-node-stage-pg15.service",
    "tala-node-stage-redis.service",
    "tala-node-stage-pm2.service",
)
NODE = HOME / ".local/node24/bin/node"
PM2_JS = HOME / ".local/lib/node_modules/pm2/bin/pm2"
EXPECTED_APPS = {"tala-node-stage-api", "tala-node-stage-worker"}
APPROVAL = "I_APPROVE_ENABLE_STAGE_USER_UNITS_ONLY"


def run(command: list[str], *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, check=False, env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)


def check_user() -> bool:
    try:
        return os.geteuid() != 0 and pwd.getpwuid(os.geteuid()).pw_name == USER and (
            pwd.getpwuid(os.geteuid()).pw_dir == str(HOME))
    except (KeyError, OSError):
        return False


def stage_env() -> dict[str, str]:
    env = dict(os.environ)
    env["HOME"] = str(HOME)
    env["PATH"] = str(HOME / ".local/node24/bin") + ":" + str(HOME / ".local/bin") + ":/usr/bin:/bin"
    env["PM2_HOME"] = str(HOME / ".pm2")
    runtime = Path("/run/user") / str(os.getuid())
    env["XDG_RUNTIME_DIR"] = str(runtime)
    env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=" + str(runtime / "bus")
    return env


def units_safe() -> bool:
    if DEST.is_symlink():
        return False
    for name in UNITS:
        source = TEMPLATES / name
        dest = DEST / name
        if not source.is_file() or source.is_symlink() or dest.exists() or dest.is_symlink():
            return False
        content = source.read_text()
        if ("WantedBy=default.target" not in content
                or "[Service]" not in content
                or "[Install]" not in content
                or "User=root" in content
                or "ExecStart=/bin/sh" in content
                or "docker" in content.lower()
                or "stripe" in content.lower()):
            return False
    return True


def stage_readiness() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:18190/api/v1/ready", timeout=4) as r:
            j = json.loads(r.read(2048))
            return r.status == 200 and j.get("ready") is True and (
                j.get("financialWrites") is False)
    except (OSError, ValueError):
        return False


def pm2_apps_ok(env: dict[str, str]) -> bool:
    try:
        p = run([str(NODE), str(PM2_JS), "jlist"], env=env)
        if p.returncode != 0:
            return False
        apps = json.loads(p.stdout)
        return (
            isinstance(apps, list)
            and len(apps) == 2
            and {a.get("name") for a in apps} == EXPECTED_APPS
            and all(a.get("pm2_env", {}).get("status") == "online" for a in apps)
        )
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def linger_ok() -> bool:
    try:
        p = run(["loginctl", "show-user", USER, "-p", "Linger", "--value"])
        return p.returncode == 0 and p.stdout.strip() == "yes"
    except (OSError, subprocess.TimeoutExpired):
        return False


def user_bus_ready(env: dict[str, str]) -> bool:
    addr = Path(env["XDG_RUNTIME_DIR"]) / "bus"
    if not addr.exists() or not stat.S_ISSOCK(addr.stat().st_mode):
        return False
    try:
        p = run(["systemctl", "--user", "is-system-running"], env=env)
        # return non-zero for degraded, but a reachable manager still has output.
        return p.stdout.strip() in {"running", "degraded", "starting", "initializing"}
    except (OSError, subprocess.TimeoutExpired):
        return False


def main() -> int:
    if sys.argv[1:] not in ([], ["--plan"], ["--apply"]):
        print("USAGE --plan|--apply")
        return 2
    mode = sys.argv[1] if len(sys.argv) > 1 else "--plan"
    print("TALA_STAGE_BOOT_PERSISTENCE_BEGIN")
    if not check_user():
        print("ABORT_STAGE_USER_ONLY")
        return 1
    if not units_safe():
        print("ABORT_UNIT_SOURCE_OR_EXISTING_TARGET")
        return 1
    if not NODE.is_file() or not PM2_JS.is_file():
        print("ABORT_STAGE_NODE_PM2_MISSING")
        return 1
    if not stage_readiness():
        print("ABORT_STAGE_NOT_READY")
        return 1
    print("STAGE_API_READY=PASS")
    print("UNITS_STAGE_ONLY=PASS")
    print("LINGER=" + ("enabled" if linger_ok() else "not_enabled"))
    if mode == "--plan":
        print("NO_MUTATIONS_PLAN=PASS")
        return 0
    if os.environ.get("TALA_STAGE_BOOT_APPROVAL") != APPROVAL:
        print("ABORT_EXPLICIT_STAGE_PERSISTENCE_APPROVAL")
        return 1
    if not linger_ok():
        print("ABORT_ENABLE_LINGER_FIRST")
        return 1
    env = stage_env()
    if not user_bus_ready(env):
        print("ABORT_STAGE_USER_SYSTEMD_BUS_UNAVAILABLE")
        return 1
    if not pm2_apps_ok(env):
        print("ABORT_PM2_NOT_EXACTLY_TWO_STAGE_APPS")
        return 1
    if DEST.exists() and (not DEST.is_dir() or DEST.is_symlink()):
        print("ABORT_SYSTEMD_USER_DIR_UNSAFE")
        return 1
    try:
        DEST.mkdir(mode=0o700, parents=True, exist_ok=True)
        if stat.S_IMODE(DEST.stat().st_mode) != 0o700:
            print("ABORT_SYSTEMD_USER_DIR_MODE")
            return 1
        saved = run([str(NODE), str(PM2_JS), "save", "--force"], env=env)
        dump = HOME / ".pm2/dump.pm2"
        if saved.returncode != 0 or not dump.is_file():
            print("ABORT_STAGE_PM2_SAVE_FAILURE")
            return 1
        dump.chmod(0o600)
        print("PM2_EXACT_TWO_STAGE_APPS_SAVED=PASS")
        for name in UNITS:
            src = TEMPLATES / name
            dst = DEST / name
            # O_EXCL blocks overwrite even on a concurrent/repeated execution.
            fd = os.open(str(dst), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.write(src.read_text())
                handle.flush()
                os.fsync(handle.fileno())
        if run(["systemctl", "--user", "daemon-reload"], env=env).returncode != 0:
            raise RuntimeError("DAEMON_RELOAD_FAILED")
        if run(["systemctl", "--user", "enable", *UNITS], env=env).returncode != 0:
            raise RuntimeError("USER_ENABLE_FAILED")
        print("USER_UNITS_ENABLED_NOT_STARTED=PASS")
        print("NO_SERVICES_STOPPED_OR_RESTARTED=yes")
        print("NO_KALI_REBOOT=yes")
        print("NO_LIVE_DOCKER_OR_STRIPE_CHANGES=yes")
        return 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        print("PARTIAL_STAGE_USER_UNIT_INSTALL=CHECK_BEFORE_RETRY")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
