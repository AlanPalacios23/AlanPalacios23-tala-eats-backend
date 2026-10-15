"""F1.06 live PostgreSQL checkout concurrency: two Uvicorn workers.

ONLY on the exact disposable GitHub Actions PostgreSQL/Redis URLs with
fake credentials. No money provider, production host, or customer is contacted.

Modes:
  normal: concurrent HTTP requests, client-dropped reply simulation
  redis-outage: same guarantees with unreachable Redis endpoint
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from sqlalchemy import func, select

from app import models
from app.config import settings
from app.db import SessionLocal
from app.seed import seed_database

EXPECTED_DB = "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa"
EXPECTED_REDIS = "redis://127.0.0.1:6379/0"


def assert_isolated(mode: str) -> None:
    assert os.getenv("DATABASE_URL") == EXPECTED_DB == settings.database_url
    if mode == "normal":
        assert os.getenv("REDIS_URL") == EXPECTED_REDIS
    else:
        assert os.getenv("REDIS_URL") == "redis://127.0.0.1:6399/0"
    assert os.getenv("ENVIRONMENT") == "development"
    assert os.getenv("SEED_DEMO_DATA") == "false"
    assert not settings.stripe_enabled
    assert not settings.stripe_secret_key
    assert not settings.stripe_connect_enabled
    assert not settings.withdrawals_live_enabled
    assert not settings.withdrawals_execution_enabled
    assert not settings.mercado_pago_access_token
    assert not settings.require_online_payments


def http(base: str, path: str, *, method: str = "GET", json_body: dict | None = None,
         headers: dict | None = None, timeout: float = 20) -> tuple[int, dict]:
    data = (json.dumps(json_body).encode() if json_body is not None else None)
    h = {"Content-Type": "application/json", **(headers or {})}
    req = Request(base + path, data=data, headers=h, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else {}
    except HTTPError as exc:
        raw = exc.read()
        return exc.code, json.loads(raw) if raw else {}


def main(mode: str) -> None:
    assert_isolated(mode)
    with SessionLocal() as db:
        seed_database(db)
        restaurant = db.scalar(select(models.Restaurant).where(
            models.Restaurant.name == "Tacos El Centro"))
        assert restaurant is not None
        item = db.scalar(select(models.MenuItem).where(
            models.MenuItem.restaurant_id == restaurant.id).order_by(models.MenuItem.id))
        assert item is not None
        rid, iid = restaurant.id, item.id

    port = 18151 if mode == "normal" else 18152
    base = f"http://127.0.0.1:{port}"
    env = {**os.environ, "SEED_DEMO_DATA": "false", "ENVIRONMENT": "development"}
    with tempfile.TemporaryDirectory(prefix="tala-f1-pg-") as tmp:
        logfile = Path(tmp) / "uvicorn.log"
        with logfile.open("w+", encoding="utf-8") as output:
            proc = subprocess.Popen(
                [sys.executable, "-m", "uvicorn", "app.main:app",
                 "--host", "127.0.0.1", "--port", str(port),
                 "--workers", "2", "--no-access-log"],
                env=env, stdout=output, stderr=subprocess.STDOUT,
            )
            try:
                deadline = time.monotonic() + 35
                while time.monotonic() < deadline:
                    if proc.poll() is not None:
                        raise AssertionError(f"Uvicorn exited early {proc.returncode}")
                    try:
                        status, _ = http(base, "/", timeout=2)
                        if status == 200:
                            break
                    except (TimeoutError, URLError, OSError):
                        pass
                    time.sleep(0.2)
                else:
                    raise AssertionError("Two-worker Uvicorn did not become ready")

                # Uvicorn parent plus at least two child worker processes.
                children = subprocess.run(
                    ["ps", "-o", "pid=", "--ppid", str(proc.pid)],
                    check=True, capture_output=True, text=True,
                ).stdout.split()
                assert len(children) >= 2, f"Not enough worker children: {children}"

                status, logged = http(base, "/api/v1/auth/login", method="POST",
                    json_body={"email": "cliente@talaeats.mx",
                               "password": "Cliente123!"},
                    headers={"X-TalaEats-Client": "customer-mobile"})
                assert status == 200, (status, logged)
                auth = {"Authorization": "Bearer " + logged["access_token"]}

                reference = f"pg-parallel-{mode}-{uuid.uuid4().hex}"
                payload = {
                    "restaurant_id": rid, "address": "QA efimera Tala",
                    "order_type": "delivery", "payment_method": "cash",
                    "distance_km": 1.0, "client_reference": reference,
                    "items": [{"menu_item_id": iid, "quantity": 1}],
                }
                with SessionLocal() as db:
                    stock_before = db.get(models.MenuItem, iid).stock

                def submit(i: int, intent: dict) -> tuple[int, dict]:
                    # Every request has a distinct Redis middleware key, forcing
                    # Postgres idempotency; no shared Redis replay shortcut.
                    hdr = {**auth, "Idempotency-Key": f"f1-{uuid.uuid4().hex}-{i}"}
                    return http(base, "/api/v1/orders", method="POST",
                                json_body=intent, headers=hdr)

                with ThreadPoolExecutor(max_workers=8) as pool:
                    responses = list(pool.map(lambda i: submit(i, payload), range(8)))
                assert all(s == 201 for s, _ in responses), responses
                ids = [body["id"] for _, body in responses]
                assert len(set(ids)) == 1, ids

                # A changed order intent must 409 even with a different HTTP key.
                status, _ = submit(99, {**payload, "address": "QA other address"})
                assert status == 409, status

                with SessionLocal() as db:
                    count = db.scalar(select(func.count(models.Order.id)).where(
                        models.Order.user_id == logged["user"]["id"],
                        models.Order.client_reference == reference))
                    stock_after = db.get(models.MenuItem, iid).stock
                    ledger_count = db.scalar(select(func.count(models.FinancialLedgerEntry.id)).where(
                        models.FinancialLedgerEntry.order_id == ids[0]))
                assert count == 1, count
                assert stock_after == stock_before - 1, (stock_before, stock_after)
                assert ledger_count > 0, ledger_count

                # Model a client losing an acknowledged response after COMMIT:
                # intentionally discard first HTTP reply and recover by retry.
                lost = {**payload, "client_reference": f"pg-lost-{mode}-{uuid.uuid4().hex}"}
                ack_code, ack = submit(101, lost)
                assert ack_code == 201, (ack_code, ack)
                committed_id = ack["id"]
                del ack
                retry_code, retry = submit(102, lost)
                assert retry_code == 201 and retry["id"] == committed_id, retry
                with SessionLocal() as db:
                    assert db.scalar(select(func.count(models.Order.id)).where(
                        models.Order.client_reference == lost["client_reference"])) == 1
                print(
                    f"F1_PG_MULTIWORKER_{mode.upper().replace('-', '_')}_PASS",
                    "workers>=2 requests=8 one_order=1 stock_once=1",
                    "changed_intent=409 lost_reply_retry=once",
                    flush=True,
                )
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
                output.flush()
                if proc.returncode not in {0, -15}:
                    print("QA Uvicorn diagnostic tail:",
                          logfile.read_text(encoding="utf-8", errors="replace")[-3200:],
                          file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["normal", "redis-outage"], required=True)
    args = parser.parse_args()
    main(args.mode)
