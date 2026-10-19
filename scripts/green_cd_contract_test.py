#!/usr/bin/env python3
"""Isolated contract tests for Kali green CD. Never calls Docker or SSH."""
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "scripts/kali_green_cd.py"
WORKFLOW = ROOT / ".github/workflows/tala-green-tailscale-ssh-cd.yml"
RECEIVER = ROOT / "scripts/kali_green_cd_ssh_receiver.sh"

spec = importlib.util.spec_from_file_location("green_engine", ENGINE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.PROJECT == "talaeats-green"
assert mod.ROOT == Path("/home/alan/talaeats-green-20261018")
assert mod.valid_sha("a" * 40) == "a" * 40
for bad in ("main", "abc", "a" * 40 + " --delete", "../", ""):
    try:
        mod.valid_sha(bad)
    except mod.Blocked:
        pass
    else:
        raise AssertionError("unsafe SHA accepted: " + bad)

# Override may ONLY alter api and worker, never db or redis.
with tempfile.TemporaryDirectory() as td:
    im = "talaeats-green-cd:" + "f" * 40
    original = mod.compose
    mod.compose = lambda _, *a: json.dumps({
        "name": "talaeats-green",
        "services": {
            "api": {"image": im, "ports": [{"host_ip":"127.0.0.1","published":"18182"}]},
            "worker": {"image": im},
            "db": {"image":"postgres:16-alpine"},
            "redis": {"image":"redis:8-alpine"},
        }
    })
    override = mod.overlay(Path(td), im)
    src = override.read_text()
    assert "api:" in src and "worker:" in src
    assert "db:" not in src and "redis:" not in src
    mod.compose = original

# Proof is required for any true auto deploy, not just GitHub variable.
engine = ENGINE.read_text()
assert "get_approval_file(APPROVAL)" in engine
assert "get_approval_file(BACKUP_PROOF)" in engine
assert "offsite_sha256_verified" in engine
assert "green_automatic_backup_verified" in engine
assert "with urlopen(READY" in engine
assert "SCHEMA = " in engine
assert "SEED_DEMO_DATA" in engine and "BOOTSTRAP_ADMIN_ENABLED" in engine
assert "STRIPE_ENABLED" in engine and "WITHDRAWALS_EXECUTION_ENABLED" in engine
assert '("db", "redis")' in engine
assert '"--no-deps", "--no-build", "api", "worker"' in engine
assert 'GREEN_CD_ROLLBACK_PASS' in engine
for danger in ("talaeats-v3-backend", "talaeats-v3-worker", "docker system prune",
               "docker compose down", "alembic upgrade head", "docker volume rm"):
    assert danger not in engine, "Unacceptable engine operation: " + danger

receiver = RECEIVER.read_text()
assert "SSH_ORIGINAL_COMMAND" in receiver
assert "talaeats-green-cd probe" in receiver
assert "GREEN_CD_SSH_DENIED" in receiver
workflow = WORKFLOW.read_text()
assert "tailscale/github-action@v4" in workflow
assert "tags: tag:talaeats-ci" in workflow
assert "workflow_run:" in workflow and "workflow_dispatch:" in workflow
assert "GREEN_CD_ENABLED" in workflow
assert "StrictHostKeyChecking=yes" in workflow
assert "TALAEATS_GREEN_CD_ENABLED" in workflow
assert "TALA EATS Backend | Finanzas PostgreSQL + Redis (CI aislado)" in workflow
assert "TALA EATS Backend | Security Audit" in workflow
assert "TALA EATS Backend | Container Build Gate" in workflow
assert "github.event_name" in workflow
print("GREEN_GITHUB_SSH_CD_CONTRACT_PASS")
