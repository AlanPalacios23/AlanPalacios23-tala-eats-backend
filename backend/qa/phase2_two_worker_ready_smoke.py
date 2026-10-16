"""F2.01: isolated HTTP readiness smoke on disposable GitHub runner only.

Does not attest Kali, staging outside CI, payment providers or mobile clients.
"""
import json
import os
import subprocess
import sys
import time
from urllib.request import urlopen
from pathlib import Path

from app.config import settings

EXPECTED_DB = "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa"
EXPECTED_REDIS = "redis://127.0.0.1:6379/0"


def require_disposable_environment():
    if not (
        os.getenv("GITHUB_ACTIONS") == "true"
        and settings.database_url == EXPECTED_DB
        and settings.redis_url == EXPECTED_REDIS
        and settings.environment == "development"
        and not settings.seed_demo_data
        and not settings.stripe_enabled
        and not settings.stripe_connect_enabled
        and not settings.withdrawals_execution_enabled
        and not settings.withdrawals_live_enabled
        and not settings.mercado_pago_access_token
    ):
        raise RuntimeError("F201 only allowed in synthetic isolated CI")


def main():
    require_disposable_environment()
    working_dir = Path(__file__).resolve().parents[1]
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host",
         "127.0.0.1", "--port", "18181", "--workers", "2", "--no-access-log"],
        cwd=working_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        until = time.monotonic() + 45
        while time.monotonic() < until:
            if proc.poll() is not None:
                raise RuntimeError("F201 API exited before readiness")
            try:
                with urlopen("http://127.0.0.1:18181/api/v1/ready", timeout=3) as response:
                    payload = json.load(response)
                    if response.status == 200 and all(
                        payload.get(k) is True for k in ("ready", "database", "redis")
                    ):
                        print("F201_TWO_WORKER_LOOPBACK_READY_PASS")
                        return
            except (OSError, ValueError):
                pass
            time.sleep(0.3)
        raise RuntimeError("F201 API never reached ready")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


if __name__ == "__main__":
    main()
