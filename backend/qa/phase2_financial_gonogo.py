"""F2.12 independent, READ-ONLY financial launch-review dossier.

No API, network, payments, secrets, environment mutations or account changes.
Never emits GO, never enables money. Passing all evidence creates a MANUAL REVIEW
queue only. Each evidence pointer is an opaque internal change/ticket reference.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
from typing import Mapping

CONTROLS = (
    "git_release_sha_and_ci",
    "kali_release_api_worker_alembic",
    "pg_media_encrypted_restore",
    "staging_rollout_rollback_ledger",
    "external_ready_and_waf",
    "alert_delivery_24x7",
    "stripe_test_refund_dispute",
    "mercadopago_sandbox_reconciliation",
    "stripe_connect_test_kyc_bank",
    "cash_netting_ledger_reconciliation",
    "fraud_controls_and_risk_limits",
    "refund_chargeback_reserve_policy",
    "mx_legal_tax_privacy_review",
)
ROLES = (
    "technical_release_owner",
    "finance_reconciliation_owner",
    "security_incident_owner",
    "legal_compliance_owner",
)
HASH = re.compile(r"^[0-9a-f]{40}$")
REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_./#-]{2,99}$")


@dataclass(frozen=True)
class ReviewResult:
    status: str
    missing_controls: tuple[str, ...]
    missing_roles: tuple[str, ...]
    invalid_fields: tuple[str, ...]
    note: str


def validate_dossier(data: Mapping) -> ReviewResult:
    """Evaluate *document completeness*, not provider/bank truth or LIVE GO.

    Do not inspect network or accept secrets/tokens/CLABE numbers in this format.
    Real humans separately authenticate and verify the linked evidence.
    """
    if not isinstance(data, dict):
        raise ValueError("Dossier must be a JSON object")
    controls = data.get("controls")
    roles = data.get("role_signoffs")
    if not isinstance(controls, dict):
        controls = {}
    if not isinstance(roles, dict):
        roles = {}

    missing_controls = tuple(
        c for c in CONTROLS
        if not (isinstance(controls.get(c), dict)
                and controls[c].get("passed") is True
                and isinstance(controls[c].get("evidence_ref"), str)
                and REF.fullmatch(controls[c]["evidence_ref"]))
    )
    missing_roles = tuple(
        role for role in ROLES
        if not (isinstance(roles.get(role), dict)
                and roles[role].get("reviewed") is True
                and isinstance(roles[role].get("approval_ticket"), str)
                and REF.fullmatch(roles[role]["approval_ticket"]))
    )
    invalid = []
    if not isinstance(data.get("release_sha"), str) or not HASH.fullmatch(data["release_sha"]):
        invalid.append("release_sha")
    if data.get("environment") != "controlled-pilot":
        invalid.append("environment")
    if data.get("payment_mode") != "test":
        invalid.append("payment_mode")
    if data.get("live_execution_approved") is not False:
        invalid.append("live_execution_approved_must_remain_false")
    limits = data.get("proposed_limits")
    if not isinstance(limits, dict):
        limits = {}
    for key in (
        "single_payout_max_mxn", "daily_payout_max_mxn",
        "cash_exposure_max_mxn", "dispute_reserve_mxn",
    ):
        value = limits.get(key)
        # Keep amounts deliberately absent until a finance owner writes and
        # approves explicit limits. Booleans are not monetary amounts.
        if type(value) not in (int, float) or not (0 < value <= 1_000_000):
            invalid.append(f"proposed_limits.{key}")
    ready_for_human = not (missing_controls or missing_roles or invalid)
    return ReviewResult(
        status="REQUIRES_MANUAL_FINANCIAL_AUTHORIZATION" if ready_for_human else "NO_GO",
        missing_controls=missing_controls,
        missing_roles=missing_roles,
        invalid_fields=tuple(invalid),
        note=(
            "Completeness only; NOT a financial or bank approval. "
            "No LIVE payout, bank transfer, payment credential, deployment "
            "or automatic release action is authorized."
        ),
    )


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Read-only F2.12 dossier completeness")
    parser.add_argument("path", type=Path, help="local JSON with no credentials or personal info")
    args = parser.parse_args()
    data = json.loads(args.path.read_text(encoding="utf-8"))
    result = validate_dossier(data)
    # Deliberately print only field names, never dossier data, names or secrets.
    print(json.dumps({
        "status": result.status,
        "missing_controls": list(result.missing_controls),
        "missing_roles": list(result.missing_roles),
        "invalid_fields": list(result.invalid_fields),
        "notice": result.note,
    }, ensure_ascii=False, indent=2))
    return 0 if result.status != "NO_GO" else 2


if __name__ == "__main__":
    raise SystemExit(main())
