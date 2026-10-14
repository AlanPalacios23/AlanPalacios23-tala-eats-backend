from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
import secrets

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .config import settings

CENT = Decimal("0.01")


def money(value: Decimal | int | float | str) -> Decimal:
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def get_loyalty_account(db: Session, user_id: int, *, lock: bool = False) -> models.LoyaltyAccount:
    stmt = select(models.LoyaltyAccount).where(models.LoyaltyAccount.user_id == user_id)
    if lock:
        stmt = stmt.with_for_update()
    account = db.scalar(stmt)
    if account:
        return account
    account = models.LoyaltyAccount(
        user_id=user_id,
        referral_code=f"TALA{user_id}{secrets.randbelow(999999):06d}",
    )
    db.add(account)
    db.flush()
    return account


def _existing(db: Session, idempotency_key: str | None):
    if not idempotency_key:
        return None
    return db.scalar(select(models.WalletTransaction).where(models.WalletTransaction.idempotency_key == idempotency_key))


def credit_wallet(
    db: Session,
    user_id: int,
    amount: Decimal | int | float | str,
    *,
    kind: str,
    reference_type: str = "",
    reference_id: str = "",
    description: str = "",
    idempotency_key: str | None = None,
    account: models.LoyaltyAccount | None = None,
) -> models.WalletTransaction:
    amount = money(amount)
    if amount <= 0:
        raise HTTPException(400, "El abono a Wallet debe ser mayor que cero")
    previous = _existing(db, idempotency_key)
    if previous:
        return previous
    account = account or get_loyalty_account(db, user_id, lock=True)
    new_balance = money(account.wallet_balance + amount)
    if new_balance > Decimal(settings.wallet_max_balance):
        raise HTTPException(409, "La operación excede el saldo máximo permitido de Tala Wallet")
    account.wallet_balance = new_balance
    row = models.WalletTransaction(
        user_id=user_id,
        kind=kind,
        amount=amount,
        balance_after=new_balance,
        reference_type=reference_type,
        reference_id=str(reference_id),
        description=description[:300],
        idempotency_key=idempotency_key,
    )
    db.add(row)
    db.flush()
    return row


def debit_wallet(
    db: Session,
    user_id: int,
    amount: Decimal | int | float | str,
    *,
    kind: str,
    reference_type: str = "",
    reference_id: str = "",
    description: str = "",
    idempotency_key: str | None = None,
    account: models.LoyaltyAccount | None = None,
) -> models.WalletTransaction:
    amount = money(amount)
    if amount <= 0:
        raise HTTPException(400, "El cargo a Wallet debe ser mayor que cero")
    previous = _existing(db, idempotency_key)
    if previous:
        return previous
    account = account or get_loyalty_account(db, user_id, lock=True)
    if money(account.wallet_balance) < amount:
        raise HTTPException(400, "Saldo insuficiente en Tala Wallet")
    new_balance = money(account.wallet_balance - amount)
    account.wallet_balance = new_balance
    row = models.WalletTransaction(
        user_id=user_id,
        kind=kind,
        amount=-amount,
        balance_after=new_balance,
        reference_type=reference_type,
        reference_id=str(reference_id),
        description=description[:300],
        idempotency_key=idempotency_key,
    )
    db.add(row)
    db.flush()
    return row
