"""Read-only go-live gate for Tala Eats money flows.

NEVER takes payments, changes flags, contacts Stripe/MP, transfers funds,
updates the database or provides an authorization to execute a real charge.
A positive configuration probe is NOT proof of provider or bank readiness.
"""
from __future__ import annotations

import json
import re
from typing import Any


def _present(cfg: Any, field: str) -> bool:
    return bool(str(getattr(cfg, field, "") or "").strip())


def _flag(cfg: Any, field: str) -> bool:
    return getattr(cfg, field, False) is True


def _approved_bank_destinations_consistent(cfg: Any) -> bool:
    """Read-only shape/ownership check; never contacts Stripe or the bank."""
    accounts = list(getattr(cfg, "withdrawals_approved_accounts", None) or [])
    destinations = list(getattr(cfg, "withdrawals_approved_bank_destinations", None) or [])
    if not accounts or not destinations or len(accounts) != len(set(accounts)):
        return False
    valid_account = re.compile(r"^acct_[A-Za-z0-9]{8,80}$")
    valid_bank = re.compile(r"^ba_[A-Za-z0-9]{8,100}$")
    if any(not isinstance(account, str) or not valid_account.fullmatch(account)
           for account in accounts):
        return False
    found = set()
    for pair in destinations:
        if not isinstance(pair, str) or pair.count(":") != 1:
            return False
        account, bank = pair.split(":", 1)
        if account not in accounts or account in found or not valid_bank.fullmatch(bank):
            return False
        found.add(account)
    return found == set(accounts)


def assess_payment_go_live(cfg: Any) -> dict[str, Any]:
    """Return secret-free readiness findings without any external calls."""
    stripe_key = str(getattr(cfg, "stripe_secret_key", "") or "")
    stripe_public = str(getattr(cfg, "stripe_publishable_key", "") or "")
    stripe_webhook = str(getattr(cfg, "stripe_webhook_secret", "") or "")
    connect_webhook = str(getattr(cfg, "stripe_connect_webhook_secret", "") or "")
    live_secret = stripe_key.startswith(("sk_live_", "rk_live_"))
    live_public = stripe_public.startswith("pk_live_")
    secret_present = stripe_key.startswith(("sk_live_", "rk_live_", "sk_test_", "rk_test_"))
    public_present = stripe_public.startswith(("pk_live_", "pk_test_"))
    matched_modes = secret_present and public_present and (live_secret == live_public)
    tls_public = str(getattr(cfg, "public_base_url", "")).startswith("https://")

    def gate(config_ok: bool, reasons: list[str]) -> dict[str, Any]:
        return {
            "configuration_complete": config_ok,
            "independent_provider_and_bank_verification": False,
            "automatic_real_money_activation_authorized": False,
            "blockers": reasons,
        }

    stripe_reasons: list[str] = []
    if not _flag(cfg, "stripe_enabled"):
        stripe_reasons.append("STRIPE_ENABLED_DISABLED")
    if not matched_modes:
        stripe_reasons.append("STRIPE_KEY_MODE_OR_FORMAT_INVALID")
    if not stripe_webhook.startswith("whsec_"):
        stripe_reasons.append("STRIPE_SIGNED_WEBHOOK_MISSING")
    if not tls_public:
        stripe_reasons.append("PUBLIC_WEBHOOK_HTTPS_REQUIRED")
    if not (live_secret and live_public):
        stripe_reasons.append("STRIPE_LIVE_MODE_NOT_CONFIGURED")
    stripe_reasons.append("LIVE_PAYMENT_INTENT_AND_SIGNED_WEBHOOK_E2E_NOT_VERIFIED")
    stripe_reasons.append("BANK_AND_PLATFORM_ACCOUNT_NOT_VERIFIED")
    stripe_ok = len(stripe_reasons) == 2 and live_secret and live_public

    mp_reasons = []
    mp_token = str(getattr(cfg, "mercado_pago_access_token", "") or "")
    if mp_token.startswith("TEST-"):
        mp_reasons.append("MP_SANDBOX_CREDENTIALS_NOT_LIVE")
    if not _present(cfg, "mercado_pago_access_token"):
        mp_reasons.append("MP_ACCESS_TOKEN_MISSING")
    elif not re.fullmatch(r"APP_USR-[A-Za-z0-9_-]{12,}", mp_token):
        # Prefix is only a basic diagnostic heuristic, not PSP verification.
        mp_reasons.append("MP_LIVE_TOKEN_FORMAT_UNRECOGNIZED")
    if not _present(cfg, "mercado_pago_webhook_secret"):
        mp_reasons.append("MP_WEBHOOK_SECRET_MISSING")
    if not tls_public:
        mp_reasons.append("PUBLIC_WEBHOOK_HTTPS_REQUIRED")
    mp_reasons += [
        "MP_LIVE_MERCHANT_ACCOUNT_AND_WEBHOOK_NOT_VERIFIED",
        "MP_REFUND_AND_IDEMPOTENCY_E2E_NOT_VERIFIED",
    ]
    mp_ok = len(mp_reasons) == 2

    connect_reasons = []
    if not stripe_ok:
        connect_reasons.append("STRIPE_CHARGES_CONFIG_NOT_READY")
    if not _flag(cfg, "stripe_connect_enabled"):
        connect_reasons.append("STRIPE_CONNECT_DISABLED")
    if not connect_webhook.startswith("whsec_"):
        connect_reasons.append("STRIPE_CONNECT_WEBHOOK_MISSING")
    connect_reasons += [
        "CONNECTED_ACCOUNT_KYC_AND_BANK_DESTINATIONS_NOT_VERIFIED",
        "TRANSFER_BALANCE_REFUND_AND_DISPUTE_E2E_NOT_VERIFIED",
        "DOUBLE_PAYOUT_RECONCILIATION_NOT_VERIFIED",
    ]
    connect_ok = len(connect_reasons) == 3

    withdrawals_reasons = []
    if not connect_ok:
        withdrawals_reasons.append("CONNECT_CONFIGURATION_INCOMPLETE")
    for key in ("withdrawals_preview_enabled", "withdrawals_execution_enabled",
                "withdrawals_live_enabled"):
        if not _flag(cfg, key):
            withdrawals_reasons.append(key.upper() + "_DISABLED")
    approved_accounts = getattr(cfg, "withdrawals_approved_accounts", None)
    approved_destinations = getattr(cfg, "withdrawals_approved_bank_destinations", None)
    if not approved_accounts:
        withdrawals_reasons.append("APPROVED_CONNECT_ACCOUNTS_MISSING")
    if not approved_destinations:
        withdrawals_reasons.append("APPROVED_BANK_DESTINATIONS_MISSING")
    if approved_accounts and approved_destinations and not _approved_bank_destinations_consistent(cfg):
        withdrawals_reasons.append("APPROVED_BANK_DESTINATIONS_MISMATCH")
    withdrawals_reasons += [
        "LIVE_2FA_PAYOUT_BANK_DESTINATION_E2E_NOT_VERIFIED",
        "CASH_AND_LEGACY_PAYOUT_HOLDS_NOT_RECONCILED",
    ]
    withdrawals_ok = len(withdrawals_reasons) == 2

    cash_reasons = ["AUTOMATED_CASH_COLLECTION_PROVIDER_NOT_IMPLEMENTED",
                    "CASH_CUSTODY_AND_BANK_RECONCILIATION_NOT_IMPLEMENTED",
                    "AUTOMATED_NETTING_NOT_IMPLEMENTED",
                    "LEGAL_CONSENT_AND_LOSS_LIMITS_NOT_VERIFIED"]
    if not _flag(cfg, "cash_checkout_enabled"):
        cash_reasons.insert(0, "CASH_CHECKOUT_DISABLED")

    # The existing shadow ledger is not a money-movement service.
    return {
        "type": "preproduction_configuration_audit",
        "mutates_money_or_configuration": False,
        "authorizes_real_money_activation": False,
        "live_account_verified": False,
        "bank_reconciliation_verified": False,
        "settlement_engine": "shadow_only" if _flag(cfg, "finance_v2_shadow_enabled") else "disabled",
        "flows": {
            "stripe_card_charges": gate(stripe_ok, stripe_reasons),
            "mercado_pago_checkout": gate(mp_ok, mp_reasons),
            "stripe_connect_transfers": gate(connect_ok, connect_reasons),
            "bank_withdrawals": gate(withdrawals_ok, withdrawals_reasons),
            "physical_cash_auto_recovery": gate(False, cash_reasons),
        },
        "manual_release_approval_required": True,
    }


def main() -> int:
    from .config import settings
    result = assess_payment_go_live(settings)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    # Even an apparently complete configuration cannot prove live provider
    # capabilities, payment webhooks or bank reconciliation.
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
