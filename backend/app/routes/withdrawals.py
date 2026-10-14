"""v1.6.3 conservative Stripe Connect *bank payout* API.

Only already-completed per-order Connect transfers may fund an on-demand payout.
No transfer creation is performed by these endpoints. Old cash/manual payout
history causes a fail-closed reconciliation hold, never an estimated payout.
All requests lock a beneficiary row and retain money reservations on uncertain
provider outcomes. Both feature flags default OFF.
"""
from __future__ import annotations

import logging
import re
import hmac
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from .. import models
from ..config import settings
from ..cache import _client as redis_client
from ..db import get_db
from ..deps import require_role
from ..monetization import post_ledger_entry
from ..security import _totp_code, verify_totp
from ..stripe_gateway import stripe_client, data_dict, money_cents

log = logging.getLogger("talaeats.withdrawals")
router = APIRouter(prefix="/api/v1/withdrawals", tags=["withdrawals"])

ACCOUNT = re.compile(r"^acct_[A-Za-z0-9]{8,80}$")
BANK = re.compile(r"^ba_[A-Za-z0-9]{8,100}$")
KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_-]{15,95}$")
RETAINED = ("reserved", "submitted", "paid", "unknown", "review_required")


def _live_mode() -> bool:
    return settings.stripe_secret_key.startswith(("sk_live_", "rk_live_"))


def _approved_bank_destination(account: str) -> str | None:
    """Pin the exact payout destination for LIVE; fail closed on missing/ambiguous pairs."""
    if not _live_mode():
        return None
    matches = [entry.split(":", 1)[1] for entry in settings.withdrawals_approved_bank_destinations
               if entry.startswith(account + ":") and entry.count(":") == 1]
    if len(matches) != 1 or not BANK.fullmatch(matches[0]):
        raise HTTPException(409, "Destino bancario LIVE pendiente de aprobación")
    return matches[0]



class RequestPayout(BaseModel):
    amount_cents: int = Field(ge=100, le=10_000_000)
    totp: str = Field(pattern=r"^\d{6}$")


def _feature(write: bool = False) -> None:
    if not settings.withdrawals_preview_enabled:
        raise HTTPException(503, "Retiros aún no habilitados")
    if write and not settings.withdrawals_execution_enabled:
        raise HTTPException(503, "Retiros bancarios todavía no habilitados")
    if not settings.stripe_enabled or not settings.stripe_connect_enabled:
        raise HTTPException(503, "Stripe Connect no está habilitado")
    if write and not settings.stripe_connect_webhook_secret:
        raise HTTPException(503, "Webhook de Stripe Connect no configurado")
    if write and settings.stripe_secret_key.startswith(("sk_live_", "rk_live_")):
        if not settings.withdrawals_live_enabled or not settings.withdrawals_approved_accounts:
            raise HTTPException(503, "Retiros LIVE pendientes de autorización")
        if not settings.withdrawals_approved_bank_destinations:
            raise HTTPException(503, "Destinos bancarios LIVE no aprobados")


def _rate_limit_2fa(user_id: int, role: str, recipient_id: int) -> None:
    """Shared Redis OTP brute-force protection, fail-closed when live.

    A UTC 15-minute bucket is used across backend workers. This is in
    addition to the IP-based middleware, and is keyed by authenticated user.
    """
    if not settings.is_production:
        return
    try:
        client = redis_client()
        if client is None:
            raise RuntimeError("No shared rate limiter")
        bucket = int(time.time() // 900)
        key = f"withdrawals:otp_attempts:v163:{user_id}:{role}:{recipient_id}:{bucket}"
        pipeline = client.pipeline(transaction=True)
        pipeline.incr(key)
        pipeline.expire(key, 960)
        count = int(pipeline.execute()[0])
    except Exception as exc:
        log.error("Withdrawal OTP limiter unavailable: %s", type(exc).__name__)
        raise HTTPException(503, "Verificación de seguridad temporalmente no disponible") from exc
    if count > 5:
        raise HTTPException(429, "Demasiadas verificaciones. Intenta después")


def _recipient(db: Session, user: models.User, role: str, recipient_id: int, *, lock=False):
    if role == "restaurant" and user.role == "restaurant":
        stmt = select(models.Restaurant).where(models.Restaurant.id == recipient_id, models.Restaurant.owner_id == user.id)
        if lock:
            stmt = stmt.with_for_update()
        entity = db.scalar(stmt)
    elif role == "driver" and user.role == "driver" and user.id == recipient_id:
        stmt = select(models.DriverProfile).where(models.DriverProfile.user_id == user.id, models.DriverProfile.is_verified.is_(True))
        if lock:
            stmt = stmt.with_for_update()
        entity = db.scalar(stmt)
    else:
        entity = None
    if entity is None:
        raise HTTPException(404, "Beneficiario no disponible")
    ref = str(entity.payout_account_ref or "")
    if not ACCOUNT.fullmatch(ref):
        raise HTTPException(409, "Falta vincular una cuenta Stripe Connect verificada")
    if _live_mode():
        if ref not in settings.withdrawals_approved_accounts:
            raise HTTPException(409, "Cuenta Connect pendiente de aprobación de retiros LIVE")
        _approved_bank_destination(ref)
    if role == "restaurant" and (entity.verification_status != "verified" or entity.onboarding_status != "approved"):
        raise HTTPException(409, "Restaurante no verificado para retiros")
    # A Connect account cannot simultaneously belong to another merchant/driver.
    other_restaurant = db.scalar(select(models.Restaurant.id).where(
        models.Restaurant.payout_account_ref == ref,
        models.Restaurant.id != (recipient_id if role == "restaurant" else -1)).limit(1))
    other_driver = db.scalar(select(models.DriverProfile.user_id).where(
        models.DriverProfile.payout_account_ref == ref,
        models.DriverProfile.user_id != (recipient_id if role == "driver" else -1)).limit(1))
    if other_restaurant or other_driver:
        raise HTTPException(409, "Cuenta Connect vinculada a más de un beneficiario")
    return entity, ref


def _legacy_holds(db: Session, role: str, recipient_id: int) -> None:
    # Legacy weekly/manual/provider payouts may overlap with Stripe settlements.
    # A cash collector already holds physical money. Never permit on-demand
    # Stripe payout as long as unreconciled collector exposure is outstanding.
    if settings.finance_v2_shadow_enabled:
        wallet = db.scalar(select(models.FinanceV2Wallet).where(
            models.FinanceV2Wallet.owner_type == role,
            models.FinanceV2Wallet.owner_id == recipient_id,
        ))
        if wallet is not None and wallet.cash_exposure_cents > 0:
            raise HTTPException(409, "Efectivo pendiente de conciliación; retiro retenido")
    if db.scalar(select(models.Payout.id).where(models.Payout.payee_type == role, models.Payout.payee_id == recipient_id).limit(1)):
        raise HTTPException(409, "Liquidaciones anteriores requieren conciliación manual")
    if role == "driver" and db.scalar(select(models.CashSettlement.id).where(
        models.CashSettlement.driver_id == recipient_id,
        models.CashSettlement.status != "settled",
        models.CashSettlement.amount_due_platform > 0,
    ).limit(1)):
        raise HTTPException(409, "Cobros en efectivo pendientes de conciliación")


def _eligible(db: Session, role: str, recipient_id: int, account: str) -> tuple[int, list[tuple[str, int, str, int]]]:
    """Never derive withdrawable funds from gross sales/earnings/order ledger.

    Only *completed* per-order Stripe transfers for delivered, fully paid,
    non-refunded orders, after a configurable delay. This avoids cash/wallet,
    unmatured transfers, duplicate counts, and unpaid/canceled orders.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.withdrawals_min_age_days)
    criteria = [
        models.StripeTransfer.recipient_type == role,
        models.StripeTransfer.connected_account_id == account,
        models.StripeTransfer.status == "completed",
        models.StripeTransfer.transfer_id.like("tr_%"),
        models.Order.payment_method == "stripe",
        models.Order.payment_status == "paid",
        models.Order.status == "delivered",
        models.Order.delivered_at.is_not(None),
        models.Order.delivered_at <= cutoff,
        models.Order.refunded_amount == Decimal("0"),
    ]
    if role == "restaurant":
        criteria.append(models.Order.restaurant_id == recipient_id)
    else:
        criteria.extend([models.Order.driver_id == recipient_id, models.Order.order_type == "delivery"])
    rows = db.execute(select(models.StripeTransfer.amount_cents, models.Order.restaurant_payout,
                             models.Order.driver_earning, models.Order.tip, models.Order.order_type,
                             models.StripeTransfer.transfer_id, models.Order.payment_provider_id, models.Order.total)
                      .join(models.Order, models.StripeTransfer.order_id == models.Order.id)
                      .where(*criteria)).all()
    total = 0
    transfers = []
    for actual, merchant, driver, tip, order_type, transfer_id, payment_intent, order_total in rows:
        expected = (money_cents(merchant) if role == "restaurant" else
                    money_cents(Decimal(driver or 0) + (Decimal(tip or 0) if order_type == "delivery" else Decimal(0))))
        # A foreign, over/under-paid or partially transferred order is not safe to pay out.
        if actual != expected or expected <= 0:
            continue
        total += actual
        transfers.append((transfer_id, actual, payment_intent, money_cents(order_total)))
    if len(transfers) > 100 or len({row[0] for row in transfers}) != len(transfers):
        raise HTTPException(409, "Transferencias numerosas o repetidas requieren auditoría")
    return total, transfers


def _reserved(db: Session, role: str, recipient_id: int) -> int:
    return int(db.scalar(select(func.coalesce(func.sum(models.WithdrawalRequest.amount_cents), 0))
                         .where(models.WithdrawalRequest.payee_type == role,
                                models.WithdrawalRequest.payee_id == recipient_id,
                                models.WithdrawalRequest.status.in_(RETAINED))) or 0)


def _provider(client, account: str, *, local_known: set[str], transfers: list[tuple[str, int, str, int]]):
    """Fail closed unless Stripe proves payout account is manual/dedicated.

    Any unknown/automatic provider payout means our accounting might omit funds
    already sent to a bank; never trust our local numbers in that state.
    """
    # Confirm that each immutable local transfer is still intact at Stripe.
    for tid, amount, expected_pi, expected_total in transfers:
        remote = data_dict(client.v1.transfers.retrieve(tid))
        charge_id = remote.get("source_transaction")
        if (remote.get("id") != tid or remote.get("destination") != account
                or remote.get("currency") != "mxn" or int(remote.get("amount", -1)) != amount
                or int(remote.get("amount_reversed", -1)) != 0
                or not str(charge_id).startswith("ch_")):
            raise HTTPException(409, "Transferencia Stripe modificada o revertida; requiere conciliación")
        charge = data_dict(client.v1.charges.retrieve(charge_id))
        if (charge.get("id") != charge_id or charge.get("payment_intent") != expected_pi
                or charge.get("currency") != "mxn" or int(charge.get("amount", -1)) != expected_total
                or charge.get("paid") is not True or charge.get("captured") is not True
                or charge.get("disputed") is not False
                or int(charge.get("amount_refunded", -1)) != 0):
            raise HTTPException(409, "El cargo origen fue devuelto, disputado o no está confirmado")
    opts = {"stripe_account": account}
    entity = data_dict(client.v1.accounts.retrieve(account))
    if (entity.get("id") != account or not entity.get("payouts_enabled")
            or entity.get("country") not in {None, "MX"}):
        raise HTTPException(409, "Cuenta Connect no habilitada para retiros en México")
    requirements = entity.get("requirements") or {}
    if requirements.get("currently_due") or requirements.get("past_due") or requirements.get("disabled_reason"):
        raise HTTPException(409, "Cuenta Connect con verificaciones pendientes")
    if settings.stripe_secret_key.startswith(("sk_live_", "rk_live_")) and (
        entity.get("country") != "MX" or entity.get("details_submitted") is not True
        or not isinstance(entity.get("requirements"), dict)
    ):
        raise HTTPException(409, "Cuenta Connect LIVE de México no verificada")
    schedule = (((entity.get("settings") or {}).get("payouts") or {}).get("schedule") or {}).get("interval")
    if schedule != "manual":
        raise HTTPException(409, "Cuenta Stripe requiere calendario de retiros manual")
    # Paginate verified history; an account with >100 legitimate payouts should
    # not stop working forever. Cap at 1000 and hold on inconsistent pagination.
    cursor = None
    seen = set()
    for _page in range(10):
        params = {"limit": 100}
        if cursor:
            params["starting_after"] = cursor
        payouts = data_dict(client.v1.payouts.list(params, options=opts))
        items = [data_dict(x) for x in (payouts.get("data") or [])]
        for item in items:
            pid = str(item.get("id") or "")
            if (not pid.startswith("po_") or pid in seen or item.get("automatic")
                    or pid not in local_known):
                raise HTTPException(409, "Retiros Stripe externos o repetidos requieren conciliación")
            seen.add(pid)
            if _live_mode():
                # Any change in approved bank routing triggers a manual hold.
                if item.get("destination") != _approved_bank_destination(account):
                    raise HTTPException(409, "Historial Stripe con destino bancario diferente; conciliación")
        if not payouts.get("has_more"):
            break
        if not items or len(items) < 1 or items[-1].get("id") == cursor:
            raise HTTPException(409, "Paginación Stripe inconsistente")
        cursor = str(items[-1]["id"])
    else:
        raise HTTPException(409, "Más de 1000 retiros históricos; auditoría requerida")
    balance = data_dict(client.v1.balance.retrieve(options=opts))
    available = 0
    for row in balance.get("available") or []:
        part = data_dict(row)
        if part.get("currency") == "mxn":
            # Explicit card funding source; never infer funds from unrelated sources.
            card = (part.get("source_types") or {}).get("card")
            if card is None:
                raise HTTPException(409, "Origen de fondos Stripe no conciliable")
            available += int(card)
    if available < 0:
        raise HTTPException(409, "Saldo Stripe inválido")
    return available


def _balance(db: Session, role: str, recipient_id: int, account: str, client) -> dict:
    _legacy_holds(db, role, recipient_id)
    earned, transfers = _eligible(db, role, recipient_id, account)
    reserved = _reserved(db, role, recipient_id)
    if reserved > earned:
        raise HTTPException(409, "El saldo local requiere conciliación")
    known = set(db.scalars(select(models.WithdrawalRequest.stripe_payout_id).where(
        models.WithdrawalRequest.connected_account_id == account,
        models.WithdrawalRequest.stripe_payout_id.is_not(None))).all())
    provider_available = _provider(client, account, local_known=known, transfers=transfers)
    return {"currency": "MXN", "eligible_cents": earned,
            "already_requested_cents": reserved,
            "provider_available_cents": provider_available,
            "withdrawable_cents": max(0, min(earned - reserved, provider_available)),
            "hold_days": settings.withdrawals_min_age_days,
            "cash_eligible": False, "source": "delivered_paid_stripe_connect_transfers_only"}


def _public(row: models.WithdrawalRequest) -> dict:
    return {"id": row.id, "amount_cents": row.amount_cents, "currency": row.currency,
            "status": row.status, "created_at": row.created_at,
            "stripe_payout_id": row.stripe_payout_id or None}



def _bank_preview(client, account: str) -> dict:
    """Read-only connected-bank proof for mobile. Never return CLABE/account numbers.

    This extra response is NOT the provider authorization: the existing payout
    handler still pins the destination and validates Stripe responses/webhooks.
    Missing data or exceptions => status unavailable; no mobile write permission.
    """
    fallback = {"status": "unavailable"}
    try:
        entries = data_dict(client.v1.accounts.list_external_accounts(
            account, params={"object": "bank_account", "limit": 100}))
        if entries.get("has_more"):
            return fallback  # too many destinations: review manually
        banks = [data_dict(x) for x in entries.get("data", [])]
        approved = _approved_bank_destination(account) if _live_mode() else None
        if approved:
            banks = [x for x in banks if x.get("id") == approved]
        else:
            banks = [x for x in banks if x.get("default_for_currency") is True]
        if len(banks) != 1:
            return fallback
        bank = banks[0]
        status = str(bank.get("status") or "").lower()
        if (bank.get("object") != "bank_account" or
                bank.get("currency") != "mxn" or
                bank.get("country") != "MX" or
                not re.fullmatch(r"\d{4}", str(bank.get("last4") or "")) or
                status not in {"new", "validated", "verified"}):
            return {"status": "restricted"}
        return {"status": "verified", "last4": str(bank["last4"]),
                "bank_name": str(bank.get("bank_name") or "Cuenta bancaria")[:60]}
    except Exception as exc:
        log.warning("Stripe bank confirmation unavailable: %s", type(exc).__name__)
        return fallback


def _mobile_limits(db: Session, role: str, recipient_id: int) -> dict:
    utc_today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    allocated = int(db.scalar(select(func.coalesce(func.sum(models.WithdrawalRequest.amount_cents), 0)).where(
        models.WithdrawalRequest.payee_type == role,
        models.WithdrawalRequest.payee_id == recipient_id,
        models.WithdrawalRequest.created_at >= utc_today,
        models.WithdrawalRequest.status.in_(RETAINED))) or 0)
    return {"minimum_cents": 100,
            "per_request_cents": settings.withdrawals_max_request_cents,
            "daily_remaining_cents": max(0, settings.withdrawals_max_daily_cents - allocated)}


@router.get("/{role}/{recipient_id}/balance")
def balance(role: str, recipient_id: int,
            user: models.User = Depends(require_role("restaurant", "driver")),
            db: Session = Depends(get_db)):
    _feature()
    _, acct = _recipient(db, user, role, recipient_id)
    try:
        client = stripe_client()
        snapshot = _balance(db, role, recipient_id, acct, client)
        bank = _bank_preview(client, acct)
        limits = _mobile_limits(db, role, recipient_id)
        pending = db.scalar(select(models.WithdrawalRequest.id).where(
            models.WithdrawalRequest.payee_type == role,
            models.WithdrawalRequest.payee_id == recipient_id,
            models.WithdrawalRequest.status.in_(("reserved", "submitted", "unknown", "review_required"))).limit(1))
        switches = (settings.withdrawals_execution_enabled and
            settings.stripe_connect_webhook_secret and user.two_factor_enabled and user.totp_secret)
        live_allowed = (not _live_mode() or
            (settings.withdrawals_live_enabled and
             acct in settings.withdrawals_approved_accounts and
             _approved_bank_destination(acct) is not None))
        snapshot.update({
            "bank": bank, "limits": limits,
            "server_allows_requests": bool(switches and live_allowed and
                bank["status"] == "verified" and not pending and
                snapshot["withdrawable_cents"] >= 100 and
                limits["daily_remaining_cents"] >= 100),
            "reconciling": bool(pending),
            "bank_onboarding_available": False,
        })
        return snapshot
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("Balance unavailable: %s", type(exc).__name__)
        raise HTTPException(503, "No se pudo confirmar el saldo real con Stripe") from exc


@router.get("/{role}/{recipient_id}/history")
def history(role: str, recipient_id: int,
            user: models.User = Depends(require_role("restaurant", "driver")),
            db: Session = Depends(get_db)):
    _feature()
    _recipient(db, user, role, recipient_id)
    return [_public(x) for x in db.scalars(select(models.WithdrawalRequest).where(
        models.WithdrawalRequest.payee_type == role, models.WithdrawalRequest.payee_id == recipient_id)
        .order_by(models.WithdrawalRequest.id.desc()).limit(50))]


@router.post("/{role}/{recipient_id}/request", status_code=202)
def request_withdrawal(role: str, recipient_id: int, payload: RequestPayout,
                       idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
                       user: models.User = Depends(require_role("restaurant", "driver")),
                       db: Session = Depends(get_db)):
    _feature(write=True)
    if not idempotency_key or not KEY.fullmatch(idempotency_key):
        raise HTTPException(400, "Idempotency-Key inválido (16-96 caracteres)")
    if payload.amount_cents > settings.withdrawals_max_request_cents:
        raise HTTPException(409, "Importe superior al límite permitido por retiro")
    # Validate owner and allow idempotent reads of the *same* recorded request
    # before consuming another OTP. This does NOT resend a Stripe request.
    _, acct = _recipient(db, user, role, recipient_id, lock=True)
    bank = _approved_bank_destination(acct)
    existing = db.scalar(select(models.WithdrawalRequest).where(
        models.WithdrawalRequest.payee_type == role,
        models.WithdrawalRequest.payee_id == recipient_id,
        models.WithdrawalRequest.client_key == idempotency_key))
    if existing:
        if (existing.amount_cents != payload.amount_cents or existing.connected_account_id != acct
                or existing.bank_destination_id != bank):
            raise HTTPException(409, "Solicitud duplicada con diferente importe o cuenta/destino")
        return _public(existing)
    _rate_limit_2fa(user.id, role, recipient_id)
    # Unlike login, the TOTP counter must be single-use for outgoing money.
    verified_step = None
    if user.two_factor_enabled and user.totp_secret:
        step = int(time.time() // 30)
        for candidate in (step, step - 1, step + 1):
            try:
                if hmac.compare_digest(_totp_code(user.totp_secret, candidate), payload.totp):
                    verified_step = candidate
                    break
            except (ValueError, TypeError):
                pass
    if verified_step is None:
        raise HTTPException(403, "Confirma el retiro con 2FA vigente")
    # The recipient is locked above, ensuring the same payee is serialized
    # against other requests during reservation. No duplicate provider call.
    if db.scalar(select(models.WithdrawalRequest.id).where(
        models.WithdrawalRequest.requested_by == user.id,
        models.WithdrawalRequest.otp_step == verified_step).limit(1)):
        raise HTTPException(409, "Código 2FA ya utilizado para otro retiro")
    # Cents allocated during the UTC day are counted even if a payout was
    # paid. This keeps an attacker from draining a Connect account in rapid
    # successful requests even with distinct OTPs.
    utc_today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    daily_allocated = int(db.scalar(select(func.coalesce(func.sum(models.WithdrawalRequest.amount_cents), 0)).where(
        models.WithdrawalRequest.payee_type == role,
        models.WithdrawalRequest.payee_id == recipient_id,
        models.WithdrawalRequest.created_at >= utc_today,
        models.WithdrawalRequest.status.in_(RETAINED),
    )) or 0)
    if daily_allocated + payload.amount_cents > settings.withdrawals_max_daily_cents:
        raise HTTPException(409, "Límite diario de retiros alcanzado")
    # No second payout while any older request could still be in flight.
    if db.scalar(select(models.WithdrawalRequest.id).where(
        models.WithdrawalRequest.payee_type == role,
        models.WithdrawalRequest.payee_id == recipient_id,
        models.WithdrawalRequest.status.in_(("reserved", "submitted", "unknown", "review_required"))).limit(1)):
        raise HTTPException(409, "Existe un retiro pendiente de conciliación")
    try:
        snapshot = _balance(db, role, recipient_id, acct, stripe_client())
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("Withdrawal verification unavailable: %s", type(exc).__name__)
        raise HTTPException(503, "No se pudo verificar saldo y movimientos en Stripe") from exc
    if payload.amount_cents > snapshot["withdrawable_cents"]:
        raise HTTPException(409, "Importe superior al saldo realmente disponible")
    row = models.WithdrawalRequest(payee_type=role, payee_id=recipient_id, requested_by=user.id,
                                   connected_account_id=acct, bank_destination_id=bank,
                                   client_key=idempotency_key,
                                   amount_cents=payload.amount_cents, otp_step=verified_step,
                                   status="reserved")
    db.add(row)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "Retiro duplicado o código 2FA ya utilizado") from exc
    db.refresh(row)
    # Reserves funds BEFORE calling Stripe. Any timeout is ambiguous, and never
    # automatically releases funds or retries with a different key.
    try:
        payout_args = {
            "amount": row.amount_cents, "currency": "mxn", "method": "standard", "source_type": "card",
            "description": "Tala Eats retiro de ganancias",
            "metadata": {"tala_withdrawal_id": str(row.id), "payee_type": role, "payee_id": str(recipient_id)},
        }
        if bank:
            payout_args["destination"] = bank
        created = data_dict(stripe_client().v1.payouts.create(payout_args, options={"stripe_account": acct,
                    "idempotency_key": f"tala:bank-withdrawal:v1:{row.id}"}))
        if (not str(created.get("id", "")).startswith("po_") or
                created.get("currency") != "mxn" or
                int(created.get("amount", -1)) != row.amount_cents or
                created.get("status") not in {"pending", "in_transit", "paid"} or
                ("livemode" in created and bool(created["livemode"]) !=
                 settings.stripe_secret_key.startswith(("sk_live_", "rk_live_"))) or
                created.get("automatic") is True or
                (bank and created.get("destination") != bank) or
                (_live_mode() and (created.get("livemode") is not True or
                    (created.get("metadata") or {}).get("tala_withdrawal_id") != str(row.id) or
                    (created.get("metadata") or {}).get("payee_type") != role or
                    (created.get("metadata") or {}).get("payee_id") != str(recipient_id)))):
            raise RuntimeError("Respuesta payout Stripe inconsistente")
        # Webhook can arrive *before* the provider response. Refresh under a DB
        # row lock, never downgrade 'paid' or 'review_required' to submitted.
        row = db.scalar(select(models.WithdrawalRequest).where(
            models.WithdrawalRequest.id == row.id).with_for_update().execution_options(populate_existing=True))
        if row.stripe_payout_id and row.stripe_payout_id != created["id"]:
            raise RuntimeError("Stripe payout ID inconsistente con webhook")
        row.stripe_payout_id = created["id"]
        if row.status == "reserved":
            row.status = "submitted"  # Paid ONLY via a separately signed Connect event.
    except Exception as exc:
        db.rollback()
        row = db.scalar(select(models.WithdrawalRequest).where(
            models.WithdrawalRequest.id == row.id).with_for_update().execution_options(populate_existing=True))
        if row.status in {"reserved", "submitted"}:
            row.status = "unknown"
            row.error_code = type(exc).__name__[:80]
        db.commit()
        log.error("Withdrawal payout uncertain id=%s type=%s", row.id, type(exc).__name__)
        raise HTTPException(503, "Estado de retiro incierto; conciliación administrativa requerida") from exc
    db.commit()
    return _public(row)


@router.post("/stripe-connect/webhook", include_in_schema=False)
async def connect_webhook(request: Request, db: Session = Depends(get_db)):
    # A separate Connect webhook signing secret must be configured for connected accounts.
    from stripe import Webhook
    if not settings.stripe_connect_webhook_secret:
        raise HTTPException(503, "Webhook Connect no configurado")
    body = await request.body()
    if len(body) > 1024 * 1024:
        raise HTTPException(413, "Webhook Connect demasiado grande")
    signature = request.headers.get("stripe-signature", "")
    try:
        event = Webhook.construct_event(body, signature, settings.stripe_connect_webhook_secret,
                                        tolerance=settings.stripe_max_event_age)
        event = data_dict(event)
    except Exception as exc:
        raise HTTPException(400, "Firma Stripe Connect inválida") from exc
    eid = str(event.get("id", ""))
    acct = str(event.get("account", ""))
    kind = str(event.get("type", ""))
    obj = data_dict((event.get("data") or {}).get("object") or {})
    if not eid.startswith("evt_") or len(eid) > 220 or not ACCOUNT.fullmatch(acct):
        raise HTTPException(400, "Evento Connect inválido")
    if bool(event.get("livemode")) != settings.stripe_secret_key.startswith(("sk_live_", "rk_live_")):
        raise HTTPException(400, "Modo Stripe incorrecto")
    if obj.get("livemode") is not None and bool(obj["livemode"]) != bool(event.get("livemode")):
        raise HTTPException(400, "Payout Stripe incompatible con modo del webhook")
    prior = db.scalar(select(models.PaymentEvent.id).where(models.PaymentEvent.provider == "stripe_connect",
                              models.PaymentEvent.provider_event_id == eid))
    if prior:
        return {"received": True, "duplicate": True}
    if kind in {"payout.created", "payout.updated", "payout.paid", "payout.failed", "payout.canceled"}:
        payout_id = str(obj.get("id", ""))
        metadata = obj.get("metadata") or {}
        requested = str(metadata.get("tala_withdrawal_id", ""))
        row = db.scalar(select(models.WithdrawalRequest).where(
            models.WithdrawalRequest.id == int(requested) if requested.isdigit() else False).with_for_update())
        if row is not None:
            if not str(payout_id).startswith("po_"):
                raise HTTPException(409, "Payout Stripe inválido")
            if (row.connected_account_id != acct or obj.get("currency") != "mxn" or
                    row.amount_cents != int(obj.get("amount", -1)) or
                    (row.stripe_payout_id and row.stripe_payout_id != payout_id)):
                raise HTTPException(409, "Evento payout no corresponde al beneficiario, importe o moneda")
            # A signed event proves Stripe sent it, not that OUR app created
            # that payout. Verify provider ownership and metadata before
            # recording a bank payment or binding a previously unknown ID.
            try:
                remote = data_dict(stripe_client().v1.payouts.retrieve(payout_id, options={"stripe_account": acct}))
            except Exception as exc:
                log.warning("Connect payout retrieve failed, event=%s", eid)
                raise HTTPException(503, "No fue posible verificar el payout con Stripe") from exc
            meta = remote.get("metadata") or {}
            if (remote.get("id") != payout_id or remote.get("currency") != "mxn" or
                    int(remote.get("amount", -1)) != row.amount_cents or
                    meta.get("tala_withdrawal_id") != str(row.id) or
                    meta.get("payee_type") != row.payee_type or
                    meta.get("payee_id") != str(row.payee_id) or
                    remote.get("automatic") is True or
                    (row.bank_destination_id and remote.get("destination") != row.bank_destination_id) or
                    (_live_mode() and (not row.bank_destination_id or remote.get("livemode") is not True)) or
                    ("livemode" in remote and bool(remote["livemode"]) != bool(event.get("livemode")))):
                raise HTTPException(409, "Payout Stripe ajeno o inconsistente")
            if not row.stripe_payout_id:
                row.stripe_payout_id = payout_id
            if (kind == "payout.paid" and remote.get("status") != "paid") or (
                kind == "payout.failed" and remote.get("status") != "failed") or (
                kind == "payout.canceled" and remote.get("status") != "canceled"
            ):
                # Do not acknowledge a terminal webhook without matching the
                # provider's authoritative current state. Stripe will retry.
                raise HTTPException(503, "Estado del payout pendiente de conciliación")
            if kind == "payout.paid" and row.status not in {"paid", "review_required"}:
                row.status = "paid"
                post_ledger_entry(db, idempotency_key=f"withdrawal:{row.id}:stripe:payout:paid",
                                  account="stripe_connected_bank_payout", direction="debit",
                                  amount=Decimal(row.amount_cents) / 100,
                                  kind="withdrawal_paid", description="Stripe Connect confirmó payout bancario",
                                  user_id=row.requested_by,
                                  restaurant_id=row.payee_id if row.payee_type == "restaurant" else None)
            elif kind in {"payout.failed", "payout.canceled"}:
                if row.status == "paid":
                    post_ledger_entry(db, idempotency_key=f"withdrawal:{row.id}:stripe:payout:reversed",
                                      account="stripe_connected_bank_payout", direction="credit",
                                      amount=Decimal(row.amount_cents) / 100,
                                      kind="withdrawal_reversal", description="Stripe reportó falla/cancelación del payout",
                                      user_id=row.requested_by,
                                      restaurant_id=row.payee_id if row.payee_type == "restaurant" else None)
                # Provider may credit connected balance again. Do not unlock local
                # funds before an administrator reconciles original payment and payout.
                row.status = "review_required"
            elif row.status in {"reserved", "unknown"} and remote.get("status") in {"pending", "in_transit"}:
                row.status = "submitted"
    db.add(models.PaymentEvent(provider="stripe_connect", provider_event_id=eid,
                               event_type=kind[:80], payload=body.decode("utf-8", errors="replace")[:8000]))
    try:
        db.commit()
    except IntegrityError:
        # Two Stripe retries can pass the first duplicate precheck concurrently.
        # Roll back *all* state changes and acknowledge only a genuinely stored ID.
        db.rollback()
        exists = db.scalar(select(models.PaymentEvent.id).where(
            models.PaymentEvent.provider == "stripe_connect",
            models.PaymentEvent.provider_event_id == eid))
        if exists:
            return {"received": True, "duplicate": True}
        raise
    return {"received": True}


# v1.6.4: self-service Stripe-hosted onboarding. Independent of payouts.
# This endpoint NEVER authorizes a bank destination or moves money.
from urllib.parse import urlparse
from fastapi.responses import HTMLResponse
import hashlib


def _onboarding_rate_limit(user_id: int, role: str, recipient_id: int) -> None:
    """Shared limiter on issuance of sensitive Stripe links; fail closed in production."""
    if not settings.is_production:
        return
    try:
        client = redis_client()
        if client is None:
            raise RuntimeError("Redis unavailable")
        key = f"stripe:connect:onboarding:v164:{user_id}:{role}:{recipient_id}:{int(time.time() // 900)}"
        pipeline = client.pipeline(transaction=True)
        pipeline.incr(key)
        pipeline.expire(key, 960)
        count = int(pipeline.execute()[0])
    except Exception as exc:
        log.warning("Stripe onboarding rate limiting unavailable: %s", type(exc).__name__)
        raise HTTPException(503, "Verificación temporalmente no disponible") from exc
    if count > 6:
        raise HTTPException(429, "Demasiados enlaces de registro. Intenta después")


def _onboarding_feature() -> None:
    if not settings.stripe_connect_self_service_enabled or not settings.stripe_enabled:
        raise HTTPException(503, "Registro bancario Stripe Connect todavía no habilitado")
    if not settings.stripe_secret_key.startswith(("sk_test_", "rk_test_", "sk_live_", "rk_live_")):
        raise HTTPException(503, "Stripe no está configurado para incorporación bancaria")


def _self_service_owner(db: Session, user: models.User, role: str, recipient_id: int, lock=False):
    if role == "restaurant" and user.role == "restaurant":
        stmt = select(models.Restaurant).where(models.Restaurant.id == recipient_id,
                                                models.Restaurant.owner_id == user.id)
        entity = db.scalar(stmt.with_for_update() if lock else stmt)
        if entity and (entity.verification_status != "verified" or entity.onboarding_status != "approved"):
            raise HTTPException(409, "Restaurante pendiente de aprobación")
    elif role == "driver" and user.role == "driver" and user.id == recipient_id:
        stmt = select(models.DriverProfile).where(models.DriverProfile.user_id == user.id,
                                                   models.DriverProfile.is_verified.is_(True))
        entity = db.scalar(stmt.with_for_update() if lock else stmt)
    else:
        entity = None
    if not entity:
        raise HTTPException(404, "Beneficiario no autorizado")
    return entity


def _safe_stripe_link(value: str) -> str:
    u = urlparse(value)
    if u.scheme != "https" or u.hostname not in {"connect.stripe.com", "dashboard.stripe.com"} or u.username or u.password or u.port:
        raise HTTPException(502, "Stripe devolvió un enlace de verificación inválido")
    return value


class ConnectOnboardingRequest(BaseModel):
    # Never store the OTP: only used when opening an existing verified Express dashboard.
    totp: str | None = Field(default=None, pattern=r"^\d{6}$")


def _verified_account_binding(account: dict, *, ref: str, user_id: int,
                              role: str, recipient_id: int) -> None:
    """A Stripe ID alone is not proof of who owns its bank settings.

    New self-service accounts include user + recipient binding in Stripe metadata.
    Existing/legacy accounts without that proof must be reviewed, not silently adopted.
    """
    if account.get("id") != ref or account.get("country") != "MX":
        raise HTTPException(409, "Identidad Stripe Connect no coincide")
    if _live_mode():
        meta = account.get("metadata") or {}
        if (account.get("livemode") is not True or account.get("type") != "express" or
                meta.get("tala_role") != role or
                meta.get("tala_recipient_id") != str(recipient_id) or
                meta.get("tala_owner_user_id") != str(user_id)):
            raise HTTPException(409, "Cuenta Connect sin vinculación verificable; requiere auditoría")


def _connect_step_up(user: models.User, role: str, recipient_id: int,
                     ref: str, code: str | None) -> None:
    """Step-up and one-time replay guard for sensitive Express dashboard links."""
    _rate_limit_2fa(user.id, role, recipient_id)
    if not user.two_factor_enabled or not user.totp_secret or not verify_totp(user.totp_secret, code or ""):
        raise HTTPException(403, "Para administrar el banco confirma un código 2FA vigente")
    if settings.is_production:
        try:
            redis = redis_client()
            if redis is None:
                raise RuntimeError("Redis unavailable")
            digest = hmac.new(settings.jwt_secret.encode(),
                f"connect:{user.id}:{role}:{recipient_id}:{ref}:{code}".encode(),
                hashlib.sha256).hexdigest()
            if not redis.set(f"connect:stepup:v164h1:{digest}", "1", ex=120, nx=True):
                raise HTTPException(409, "Código 2FA ya utilizado. Espera un código nuevo")
        except HTTPException:
            raise
        except Exception as exc:
            log.error("Connect step-up guard unavailable: %s", type(exc).__name__)
            raise HTTPException(503, "Verificación 2FA temporalmente no disponible") from exc


def _bank_status_selfservice(client, ref: str) -> dict:
    try:
        result = data_dict(client.v1.accounts.list_external_accounts(
            ref, params={"object": "bank_account", "limit": 10}))
        if result.get("has_more"):
            return {"status": "review_required"}
        banks = [data_dict(x) for x in result.get("data", []) if data_dict(x).get("object") == "bank_account"]
        if len(banks) != 1:
            return {"status": "not_linked" if not banks else "review_required"}
        bank = banks[0]
        if (bank.get("country") != "MX" or bank.get("currency") != "mxn" or
                bank.get("status") not in ("new", "validated", "verified") or
                not re.fullmatch(r"[0-9]{4}", str(bank.get("last4") or ""))):
            return {"status": "review_required"}
        return {"status": "pending_review", "last4": bank["last4"],
                "bank_name": str(bank.get("bank_name") or "Banco")[:60]}
    except Exception:
        return {"status": "unavailable"}


@router.post("/{role}/{recipient_id}/connect/onboarding")
def connect_self_service_onboarding(role: str, recipient_id: int,
                                    user: models.User = Depends(require_role("restaurant", "driver")),
                                    db: Session = Depends(get_db),
                                    payload: ConnectOnboardingRequest | None = None):
    """Create/reuse owned Express account. Verified bank management needs fresh TOTP."""
    _onboarding_feature()
    _onboarding_rate_limit(user.id, role, recipient_id)
    entity = _self_service_owner(db, user, role, recipient_id, lock=True)
    ref = str(entity.payout_account_ref or "")
    if ref and not ACCOUNT.fullmatch(ref):
        raise HTTPException(409, "Identificador Connect existente requiere revisión")
    # Every hosted bank registration/link is sensitive. Verify a fresh, single-use
    # authenticator code before any provider call, including first onboarding.
    _connect_step_up(user, role, recipient_id, ref or "new-connect", payload.totp if payload else None)
    client = stripe_client()
    if not ref:
        # Stable idempotency across ambiguous Stripe API failures/DB rollbacks.
        key = f"tala:connect:v164:{role}:{recipient_id}:{user.id}"
        try:
            made = data_dict(client.v1.accounts.create({
                "type": "express", "country": "MX", "email": user.email,
                "capabilities": {"transfers": {"requested": True}},
                "settings": {"payouts": {"schedule": {"interval": "manual"}}},
                "metadata": {"tala_role": role, "tala_recipient_id": str(recipient_id),
                             "tala_owner_user_id": str(user.id)},
            }, options={"idempotency_key": key}))
        except Exception as exc:
            log.warning("Stripe onboarding account create failed %s", type(exc).__name__)
            raise HTTPException(503, "No se pudo iniciar Stripe Connect") from exc
        ref = str(made.get("id") or "")
        if not ACCOUNT.fullmatch(ref) or made.get("country") != "MX":
            raise HTTPException(502, "Cuenta Stripe Connect inesperada")
        if (db.scalar(select(models.Restaurant.id).where(models.Restaurant.payout_account_ref == ref).limit(1)) or
                db.scalar(select(models.DriverProfile.user_id).where(models.DriverProfile.payout_account_ref == ref).limit(1))):
            raise HTTPException(409, "Cuenta Stripe ya pertenece a otro beneficiario")
        entity.payout_account_ref = ref
        db.commit()
    # If Stripe has already verified the account, Express Dashboard is the safe
    # place for banking updates. Never expose a CLABE form on the app/server.
    try:
        acct = data_dict(client.v1.accounts.retrieve(ref))
        _verified_account_binding(acct, ref=ref, user_id=user.id,
                                  role=role, recipient_id=recipient_id)
        if acct.get("details_submitted") and acct.get("payouts_enabled"):
            response = data_dict(client.v1.accounts.create_login_link(ref))
        else:
            callback = settings.public_base_url.rstrip("/") + "/api/v1/withdrawals/connect/finish"
            response = data_dict(client.v1.account_links.create({
                "account": ref, "refresh_url": callback + "?expired=1",
                "return_url": callback, "type": "account_onboarding",
            }))
        url = _safe_stripe_link(str(response.get("url") or ""))
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("Stripe account link creation failed %s", type(exc).__name__)
        raise HTTPException(503, "No se pudo abrir el registro bancario seguro") from exc
    return {"url": url, "expires_at": response.get("expires_at"),
            "provider": "stripe_connect", "one_time": True}


@router.get("/{role}/{recipient_id}/connect/status")
def connect_self_service_status(role: str, recipient_id: int,
                                user: models.User = Depends(require_role("restaurant", "driver")),
                                db: Session = Depends(get_db)):
    _onboarding_feature()
    entity = _self_service_owner(db, user, role, recipient_id)
    ref = str(entity.payout_account_ref or "")
    if not ACCOUNT.fullmatch(ref):
        return {"status": "not_linked", "bank": {"status": "not_linked"},
                "can_withdraw": False, "action": "start_onboarding"}
    try:
        client = stripe_client()
        acct = data_dict(client.v1.accounts.retrieve(ref))
        _verified_account_binding(acct, ref=ref, user_id=user.id,
                                  role=role, recipient_id=recipient_id)
        requirements = acct.get("requirements") or {}
        ready = (acct.get("payouts_enabled") is True and acct.get("details_submitted") is True
                 and (acct.get("capabilities") or {}).get("transfers") == "active"
                 and not requirements.get("currently_due") and not requirements.get("past_due")
                 and not requirements.get("disabled_reason")
                 and (((acct.get("settings") or {}).get("payouts") or {}).get("schedule") or {}).get("interval") == "manual")
        bank = _bank_status_selfservice(client, ref)
        # A confirmed Stripe account does NOT automatically authorize our bank
        # payout: individual bank approval and ledger reconciliation remain mandatory.
        return {"status": "verified" if ready else "pending_verification",
                "bank": bank, "can_withdraw": False,
                "action": "view_earnings" if ready else "continue_onboarding",
                "notice": "Los retiros dependen de fondos conciliados y autorización bancaria"}
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("Connect status provider unavailable: %s", type(exc).__name__)
        raise HTTPException(503, "No se pudo verificar el estado en Stripe") from exc


@router.get("/connect/finish", response_class=HTMLResponse, include_in_schema=False)
def stripe_connect_finish(expired: int = 0):
    # Stripe redirects here on exit/expiry. This callback is NOT authentication
    # or evidence of verification; status must always be read back from Stripe.
    reason = "El enlace expiró. Regresa a TALA EATS y solicita uno nuevo." if expired else              "Regresa a la app TALA EATS y actualiza el estado de tu cuenta."
    return ("<!doctype html><html lang='es'><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width, initial-scale=1'>"
            "<title>TALA EATS · Stripe Connect</title></head><body>"
            "<main style='font:18px system-ui;max-width:480px;margin:15vh auto;padding:20px'>"
            "<h1>Registro bancario</h1><p>" + reason + "</p>"
            "<p>No compartas tu CLABE ni códigos de seguridad con terceros.</p>"
            "</main></body></html>")
