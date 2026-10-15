"""F2.12 formal financial review: fail-closed without bank/provider activity."""
from copy import deepcopy

import pytest

from app.config import settings
from qa.phase2_financial_gonogo import CONTROLS, ROLES, validate_dossier


def complete_synthetic_dossier():
    return {
        "release_sha": "a" * 40,
        "environment": "controlled-pilot",
        "payment_mode": "test",
        "live_execution_approved": False,
        "proposed_limits": {
            # QA placeholders, NOT authorized operating limits.
            "single_payout_max_mxn": 50,
            "daily_payout_max_mxn": 200,
            "cash_exposure_max_mxn": 200,
            "dispute_reserve_mxn": 100,
        },
        "controls": {
            item: {"passed": True, "evidence_ref": f"QA-DUMMY/{i + 1}"}
            for i, item in enumerate(CONTROLS)
        },
        "role_signoffs": {
            role: {"reviewed": True, "approval_ticket": f"QA-DUMMY/{i + 1}"}
            for i, role in enumerate(ROLES)
        },
    }


def test_no_go_when_no_evidence_or_operator_approval():
    result = validate_dossier({})
    assert result.status == "NO_GO"
    assert len(result.missing_controls) == len(CONTROLS)
    assert len(result.missing_roles) == len(ROLES)
    assert "live_execution_approved_must_remain_false" in result.invalid_fields


def test_complete_synthetic_dossier_is_never_money_go():
    result = validate_dossier(complete_synthetic_dossier())
    assert result.status == "REQUIRES_MANUAL_FINANCIAL_AUTHORIZATION"
    assert result.missing_controls == ()
    assert result.missing_roles == ()
    assert result.invalid_fields == ()
    assert "NOT a financial or bank approval" in result.note
    assert settings.withdrawals_live_enabled is False
    assert settings.withdrawals_execution_enabled is False


@pytest.mark.parametrize("bad", [
    {"live_execution_approved": True},
    {"payment_mode": "live"},
    {"environment": "production"},
    {"release_sha": "sha-short"},
    {"proposed_limits": {"single_payout_max_mxn": -1}},
])
def test_invalid_launch_conditions_stay_no_go(bad):
    dossier = complete_synthetic_dossier()
    if "proposed_limits" in bad:
        dossier["proposed_limits"].update(bad["proposed_limits"])
    else:
        dossier.update(bad)
    result = validate_dossier(dossier)
    assert result.status == "NO_GO"
    assert result.invalid_fields


@pytest.mark.parametrize("kind,key", [
    ("controls", CONTROLS[0]),
    ("controls", CONTROLS[-1]),
    ("role_signoffs", ROLES[0]),
    ("role_signoffs", ROLES[-1]),
])
def test_missing_evidence_or_signoff_stays_no_go(kind, key):
    dossier = complete_synthetic_dossier()
    del dossier[kind][key]
    result = validate_dossier(dossier)
    assert result.status == "NO_GO"


def test_fake_evidence_link_or_role_ticket_fails_closed():
    dossier = complete_synthetic_dossier()
    dossier["controls"][CONTROLS[0]]["evidence_ref"] = "PRIVATE KEY CONTENT"
    dossier["role_signoffs"][ROLES[0]]["approval_ticket"] = ""
    result = validate_dossier(dossier)
    assert result.status == "NO_GO"
    assert CONTROLS[0] in result.missing_controls
    assert ROLES[0] in result.missing_roles


def test_read_only_and_idempotent():
    dossier = complete_synthetic_dossier()
    before = deepcopy(dossier)
    first = validate_dossier(dossier)
    second = validate_dossier(dossier)
    assert first == second
    assert dossier == before
