#!/usr/bin/env python3
"""No mutations; boot-time stage PG15/Redis dependency and PM2 API verification."""
from __future__ import annotations
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

HOME = Path("/home/tala-node-stage")
NODE = HOME / ".local/node24/bin/node"
PM2 = HOME / ".local/lib/node_modules/pm2/bin/pm2"
REPO = HOME / "talaeats-node-source/node-backend"
EXPECTED = {"tala-node-stage-api", "tala-node-stage-worker"}


def wait_ports(seconds: int = 35) -> bool:
    deadline = time.monotonic() + seconds
    for port in (15435, 16379):
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    break
            except OSError:
                time.sleep(0.4)
        else:
            return False
    return True


def readiness() -> bool:
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:18190/api/v1/ready", timeout=3
        ) as response:
            if response.status != 200:
                return False
            body = json.loads(response.read(2048))
            return (
                body.get("ready") is True
                and body.get("database") is True
                and body.get("redis") is True
                and body.get("financialWrites") is False
            )
    except (OSError, ValueError, KeyError):
        return False


def pm2_both_online() -> bool:
    env = dict(os.environ)
    env["HOME"] = str(HOME)
    env["PM2_HOME"] = str(HOME / ".pm2")
    env["PATH"] = (
        str(HOME / ".local/node24/bin") + ":"
        + str(HOME / ".local/bin") + ":/usr/bin:/bin"
    )
    try:
        proc = subprocess.run(
            [str(NODE), str(PM2), "jlist"], env=env, cwd=REPO,
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=8, check=False,
        )
        if proc.returncode != 0:
            return False
        jobs = json.loads(proc.stdout)
        return (
            isinstance(jobs, list)
            and len(jobs) == 2
            and {job.get("name") for job in jobs} == EXPECTED
            and all(
                job.get("pm2_env", {}).get("status") == "online"
                for job in jobs
            )
        )
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def main() -> int:
    if os.getuid() == 0 or os.getenv("HOME") != str(HOME):
        print("ABORT_EXPECTED_STAGING_USER_HOME")
        return 2
    mode = sys.argv[1:] if len(sys.argv) > 1 else ["--dependencies"]
    if mode == ["--dependencies"]:
        passed = wait_ports()
        print("STAGE_NATIVE_DEPENDENCY_PORTS=" + ("PASS" if passed else "FAIL"))
        return 0 if passed else 1
    if mode == ["--health"]:
        for _ in range(24):
            if readiness() and pm2_both_online():
                print("STAGE_PM2_API_WORKER_READY=PASS")
                return 0
            time.sleep(1)
        print("STAGE_PM2_API_WORKER_READY=FAIL")
        return 1
    print("USAGE --dependencies|--health")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
