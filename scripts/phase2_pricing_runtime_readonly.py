#!/usr/bin/env python3
"""F2.11 read-only effective commercial pricing gate for the ACTUAL Kali API.

Offline --self-test never touches Docker/database/network. The operator-only
--on-kali command queries just nine nonsecret commercial settings through the
already-running backend container. No POST, deploy, migrations, secrets,
payouts or production orders are accessed or changed.
"""
from __future__ import annotations
import argparse
from decimal import Decimal, InvalidOperation
import json
import re
import subprocess

CONTAINER = "talaeats-v3-backend-1"
EXPECTED = {
    "commercial_v152.restaurant_commission_rate": "0.1500",
    "commercial_v162.service_fee_rate": "0.0700",
    "commercial_v162.service_fee_cap": "25.00",
    "commercial_v162.base_delivery_fee": "35.00",
    "commercial_v162.included_km": "2.00",
    "commercial_v162.additional_per_km": "5.00",
    "commercial_v152.base_driver_pay": "32.00",
    "commercial_v162.driver_additional_per_km": "4.00",
}
LABELS = ("com.docker.compose.project", "com.docker.compose.service")

# Executed INSIDE already-running API image only when operator requests
# --on-kali. Uses PG's transaction READ ONLY, no secrets in stdout.
INNER = r'''
import json
from sqlalchemy import select
from app import models
from app.config import settings
from app.db import SessionLocal
KEYS = %r
data = {"version": settings.app_version,
        "production": settings.is_production,
        "v152": settings.commercial_pricing_v152_enabled,
        "v162": settings.commercial_pricing_v162_enabled,
        "values": {}}
with SessionLocal() as db:
    # Refuse SQLite or a non-PostgreSQL connection; production must be PG.
    if db.bind.dialect.name != "postgresql":
        raise RuntimeError("F211_DB_NOT_POSTGRESQL")
    db.connection().exec_driver_sql("SET TRANSACTION READ ONLY")
    rows = db.scalars(select(models.SystemSetting).where(
        models.SystemSetting.key.in_(KEYS))).all()
    overrides = {row.key: row.value for row in rows}
    for key in KEYS:
        data["values"][key] = overrides.get(key)
    db.rollback()
print("F211_JSON:" + json.dumps(data, separators=(",", ":")))
''' % (tuple(EXPECTED),)


def verdict(data: dict) -> dict:
    """Strictly fail closed; no fallback-to-default when ADMIN overrides bad."""
    problems: list[str] = []
    if not isinstance(data, dict):
        return {"passed": False, "reasons": ["INVALID_ATTESTATION"]}
    if data.get("production") is not True:
        problems.append("NOT_PRODUCTION_RUNTIME")
    if data.get("v152") is not True or data.get("v162") is not True:
        problems.append("COMMERCIAL_V162_NOT_ENABLED")
    version = data.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"1\.6\.4[-a-z0-9.]+", version):
        problems.append("UNEXPECTED_RUNTIME_VERSION")
    supplied = data.get("values")
    if not isinstance(supplied, dict) or set(supplied) != set(EXPECTED):
        problems.append("SETTING_KEYS_INCOMPLETE")
        supplied = {}
    for key, expected in EXPECTED.items():
        raw = supplied.get(key)
        # Null means DEFAULTS[key] within the verified 1.6.4 release;
        # explicit override must be exact (cannot silently fall back).
        if raw is None:
            continue
        if not isinstance(raw, str):
            problems.append("INVALID_OVERRIDE_" + key)
            continue
        try:
            d = Decimal(raw)
            if not d.is_finite() or d != Decimal(expected):
                problems.append("MISMATCH_" + key)
        except InvalidOperation:
            problems.append("INVALID_OVERRIDE_" + key)
    return {"passed": len(problems) == 0,
            "reasons": problems,
            "checked_keys": len(EXPECTED),
            "mode": "effective_runtime_flags_and_db_settings",
            "psp_or_bank_reconciled": False,
            "live_money_authorized": False}


def self_test() -> None:
    base = {"production": True, "v152": True, "v162": True,
            "version": "1.6.4-connect-selfservice-hf1",
            "values": dict.fromkeys(EXPECTED)}
    assert verdict(base)["passed"]
    for key, exact in EXPECTED.items():
        with_override = {**base, "values": {**base["values"], key: exact}}
        assert verdict(with_override)["passed"]
        for invalid in ("NaN", "Infinity", "broken", "-1", "100000", "0"):
            wrong = {**base, "values": {**base["values"], key: invalid}}
            assert not verdict(wrong)["passed"], (key, invalid)
    for changed in (
        {**base, "v162": False},
        {**base, "v152": False},
        {**base, "production": False},
        {**base, "version": "1.4.0"},
        {**base, "values": {}},
        {**base, "values": {**base["values"], "unknown": "1"}},
    ):
        assert not verdict(changed)["passed"]
    print("F211_SYNTHETIC_READONLY_PRICE_GUARD_SELFTEST_PASS")


def safe_run(*args: str) -> str:
    try:
        res = subprocess.run(args, capture_output=True, text=True,
                             check=False, timeout=40)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError("READONLY_DOCKER_QUERY_UNAVAILABLE") from None
    if res.returncode != 0:
        # Never print stdout/stderr from Docker; may contain sensitive info.
        raise RuntimeError("READONLY_DOCKER_QUERY_REJECTED")
    return res.stdout.strip()


def on_kali() -> bool:
    for label, expected in zip(LABELS, ("talaeats-v3", "backend")):
        got = safe_run("docker", "inspect", "--type=container", "--format",
                       "{{index .Config.Labels \"" + label + "\"}}", CONTAINER)
        if got != expected:
            raise RuntimeError("UNEXPECTED_DOCKER_IDENTITY")
    running = safe_run("docker", "inspect", "--type=container", "--format",
                       "{{.State.Running}}", CONTAINER)
    if running != "true":
        raise RuntimeError("API_NOT_RUNNING")
    stdout = safe_run("docker", "exec", "-i", CONTAINER, "python", "-c", INNER)
    lines = [line for line in stdout.splitlines() if line.startswith("F211_JSON:")]
    if len(lines) != 1:
        raise RuntimeError("INVALID_RUNTIME_RESPONSE")
    try:
        data = json.loads(lines[0][len("F211_JSON:"):])
    except (ValueError, TypeError):
        raise RuntimeError("INVALID_RUNTIME_JSON") from None
    result = verdict(data)
    # Output never includes secret env, bank IDs, customer rows or raw settings.
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return result["passed"]


def main() -> None:
    parser = argparse.ArgumentParser(description="F2.11 precios solo lectura")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--self-test", action="store_true")
    group.add_argument("--on-kali", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    try:
        if not on_kali():
            raise SystemExit(2)
    except RuntimeError as ex:
        print("F211_READONLY_NO_GO:", str(ex))
        raise SystemExit(2) from None
    print("F211_RUNTIME_CONFIG_MATCH_ONLY_NOT_PSP_SETTLEMENT")


if __name__ == "__main__":
    main()
