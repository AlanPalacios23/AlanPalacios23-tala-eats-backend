"""F2.04 — real two-source API/worker rollback drill in disposable CI only.

Boot previous Phase-1 release, then new candidate, then previous again against
the same PostgreSQL 16/Redis 8 fixture. Validate readiness, worker Redis lease,
Alembic schema compatibility and immutable ledger preservation. Inject a
failed Alembic revision and confirm the old service can still boot.

No production host, banking credential, live provider, .env, restore or money.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from sqlalchemy import create_engine, text

from app.config import settings

DB = "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa"
REDIS = "redis://127.0.0.1:6379/0"
OLD_SHA = "e153aa9871683f96d530cd46effaf4fdfb80a253"
OLD_TAG = "tala-eats-backend-fase1-p0-rc1-20261015"
HEAD = "f21i00000001"
REPO = Path(__file__).resolve().parents[2]


def assert_disposable() -> None:
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("DATABASE_URL") == DB == settings.database_url
    assert os.environ.get("REDIS_URL") == REDIS == settings.redis_url
    assert settings.environment == "development"
    assert not settings.seed_demo_data
    assert not settings.stripe_enabled
    assert not settings.stripe_secret_key
    assert not settings.stripe_connect_enabled
    assert not settings.withdrawals_preview_enabled
    assert not settings.withdrawals_execution_enabled
    assert not settings.withdrawals_live_enabled
    assert not settings.mercado_pago_access_token


def source_sha(repo_path: Path, revision="HEAD") -> str:
    result = subprocess.run(
        ["git", "-C", str(repo_path), "rev-parse", revision],
        capture_output=True, text=True, check=True, timeout=15,
    ).stdout.strip()
    assert len(result) == 40 and all(c in "0123456789abcdef" for c in result)
    return result


def ledger_snapshot():
    engine = create_engine(DB)
    try:
        with engine.connect() as connection:
            version = connection.scalar(text("SELECT version_num FROM alembic_version"))
            entries = connection.execute(text(
                "SELECT id, idempotency_key, account, direction, amount, currency, kind "
                "FROM financial_ledger_entries ORDER BY id"
            )).all()
            assert entries, "Smoke must have created synthetic financial ledger"
            encoded = json.dumps(
                [[str(v) for v in row] for row in entries],
                separators=(",", ":"), ensure_ascii=True,
            ).encode()
            return version, len(entries), hashlib.sha256(encoded).hexdigest()
    finally:
        engine.dispose()


def require_compatible_schema(actual: str, expected: str = HEAD):
    if actual != expected:
        raise RuntimeError("BLOCK_ROLLOUT_SCHEMA_INCOMPATIBLE")


def wait_ready(base: str, process: subprocess.Popen) -> None:
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("API exited before readiness")
        try:
            with urlopen(base + "/api/v1/ready", timeout=3) as response:
                if response.status == 200:
                    payload = json.load(response)
                    if (payload.get("ready") is True and
                        payload.get("database") is True and
                        payload.get("redis") is True):
                        return
        except (TimeoutError, HTTPError, URLError, OSError, ValueError):
            pass
        time.sleep(0.25)
    raise RuntimeError("API could not become ready in isolated QA")


def worker_probe(root: Path, env) -> None:
    # Exercise actual worker Redis lock and heartbeat without running
    # scheduled jobs, notifications, cash maintenance or PSP reconciliation.
    probe = (
        "from app.worker import _acquire_cycle_lock, _release_cycle_lock, write_heartbeat\n"
        "token = _acquire_cycle_lock()\n"
        "assert token is not None, 'worker lease unavailable'\n"
        "try:\n"
        "    write_heartbeat()\n"
        "finally:\n"
        "    _release_cycle_lock(token)\n"
        "print('F204_WORKER_LEASE_HEARTBEAT_PASS')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], cwd=root / "backend",
        env=env, capture_output=True, text=True, timeout=25,
    )
    assert result.returncode == 0, "Worker startup/lease probe failed"
    assert "F204_WORKER_LEASE_HEARTBEAT_PASS" in result.stdout


def one_revision(root: Path, label: str, port: int, env) -> None:
    logfile = tempfile.TemporaryFile(mode="w+t")
    process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app",
         "--host", "127.0.0.1", "--port", str(port),
         "--workers", "1", "--no-access-log"],
        cwd=root / "backend", env=env,
        stdout=logfile, stderr=subprocess.STDOUT,
    )
    try:
        wait_ready(f"http://127.0.0.1:{port}", process)
        worker_probe(root, env)
        require_compatible_schema(ledger_snapshot()[0])
        print(f"F204_{label}_API_WORKER_READY_PASS", flush=True)
    finally:
        process.terminate()
        try:
            process.wait(timeout=12)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=4)
        logfile.close()


def simulated_failed_migration(env) -> None:
    # Alembic must fail on an unknown revision WITHOUT altering the DB.
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "f204_invalid_revision"],
        cwd=REPO / "backend", env=env,
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode != 0, "Invalid migration must not be applied"
    require_compatible_schema(ledger_snapshot()[0])
    try:
        require_compatible_schema("f20h00000001")
    except RuntimeError as exc:
        assert str(exc) == "BLOCK_ROLLOUT_SCHEMA_INCOMPATIBLE"
    else:
        raise AssertionError("Schema mismatch did not stop rollout")
    print("F204_MIGRATION_FAILURE_ROLLOUT_BLOCKED_PASS", flush=True)


def main() -> None:
    assert_disposable()
    tag = source_sha(REPO, OLD_TAG)
    assert tag == OLD_SHA, "Historical release tag changed unexpectedly"
    current_sha = source_sha(REPO)
    assert current_sha != OLD_SHA, "Need genuinely distinct Git source revisions"

    # Safety: all probes run with the exact disposable CI env.
    env = {**os.environ, "ENVIRONMENT": "development", "SEED_DEMO_DATA": "false",
           "STRIPE_ENABLED": "false", "STRIPE_CONNECT_ENABLED": "false",
           "WITHDRAWALS_EXECUTION_ENABLED": "false", "WITHDRAWALS_LIVE_ENABLED": "false",
           "STRIPE_SECRET_KEY": "", "MERCADOPAGO_ACCESS_TOKEN": ""}
    original = ledger_snapshot()
    require_compatible_schema(original[0])

    with tempfile.TemporaryDirectory(prefix="tala-f204-") as tmp:
        old_checkout = Path(tmp) / "previous"
        subprocess.run(
            ["git", "-C", str(REPO), "worktree", "add", "--detach",
             str(old_checkout), OLD_SHA],
            capture_output=True, check=True, timeout=35,
        )
        try:
            assert source_sha(old_checkout) == OLD_SHA
            one_revision(old_checkout, "PREVIOUS", 18171, env)
            assert ledger_snapshot() == original, "Previous worker/API changed ledger"
            one_revision(REPO, "CANDIDATE", 18172, env)
            assert ledger_snapshot() == original, "Candidate worker/API changed ledger"
            simulated_failed_migration(env)
            assert ledger_snapshot() == original, "Failed migration affected ledger"
            one_revision(old_checkout, "ROLLBACK", 18173, env)
            assert ledger_snapshot() == original, "Rollback changed ledger"
        finally:
            subprocess.run(
                ["git", "-C", str(REPO), "worktree", "remove", "--force",
                 str(old_checkout)],
                capture_output=True, check=False, timeout=20,
            )
    print(
        "F204_STAGING_ROLLBACK_DISPOSABLE_PASS: previous->candidate->previous, "
        "API+worker alive, failed migration, schema gate, ledger exactly preserved, "
        "NO LIVE and NO production restore",
        flush=True,
    )


if __name__ == "__main__":
    main()
