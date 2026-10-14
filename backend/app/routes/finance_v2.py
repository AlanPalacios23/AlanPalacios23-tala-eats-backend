"""Read-only Finance V2 shadow previews. No transfer, payout or debit API."""
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models
from ..config import settings
from ..db import get_db
from ..deps import require_role
from ..finance_core_v2 import (
    FinanceV2Error, balanced_lines, snapshot_from_order, wallet_deltas, wallet_preview,
)

router = APIRouter(prefix="/api/v1/finance-v2", tags=["finance-v2-shadow"])


def ensure_enabled() -> None:
    if not settings.finance_v2_shadow_enabled:
        raise HTTPException(404, "Finance V2 aún no está habilitado")


@router.get("/admin/orders/{order_id}/preview")
def order_preview(
    order_id: int,
    _: models.User = Depends(require_role("admin")),
    db: Session = Depends(get_db),
):
    ensure_enabled()
    order = db.get(models.Order, order_id)
    if order is None:
        raise HTTPException(404, "Pedido no encontrado")
    try:
        s = snapshot_from_order(order)
        lines = balanced_lines(s)
        wallets = wallet_deltas(s)
    except FinanceV2Error as exc:
        raise HTTPException(409, str(exc)) from exc
    existing = db.scalar(select(models.FinanceV2Journal).where(
        models.FinanceV2Journal.order_id == order_id,
        models.FinanceV2Journal.event_type == "delivered"))
    return {
        "order_id": order_id, "payment_method": s.payment_method,
        "total_cents": s.total, "restaurant_payable_cents": s.restaurant_payable,
        "driver_payable_cents": s.driver_payable,
        "platform_revenue_accrued_cents": s.platform_revenue,
        "cash_collector": None if not s.is_cash else {
            "type": s.collector_type, "id": s.collector_id,
            "owed_cents": s.cash_due_from_collector,
        },
        "balanced": s.balanced,
        "journal_exists": existing is not None,
        "entries": [dict(account=l.account, direction=l.direction,
                         amount_cents=l.amount) for l in lines],
        "wallet_changes": [
            {"owner_type": kind, "owner_id": who, "delta_cents": diff[0],
             "unverified_delta_cents": diff[1], "cash_exposure_delta_cents": diff[2]}
            for (kind, who), diff in sorted(wallets.items())
        ],
        "shadow_only": True, "bank_available_cents": 0,
    }


@router.get("/admin/wallets/{owner_type}/{owner_id}")
def admin_wallet(
    owner_type: str, owner_id: int,
    _: models.User = Depends(require_role("admin")),
    db: Session = Depends(get_db),
):
    ensure_enabled()
    try:
        return wallet_preview(db, owner_type, owner_id)
    except FinanceV2Error as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/driver/me/wallet")
def driver_wallet(
    user: models.User = Depends(require_role("driver")),
    db: Session = Depends(get_db),
):
    ensure_enabled()
    return wallet_preview(db, "driver", user.id)


@router.get("/restaurant/{restaurant_id}/wallet")
def restaurant_wallet(
    restaurant_id: int,
    user: models.User = Depends(require_role("restaurant")),
    db: Session = Depends(get_db),
):
    ensure_enabled()
    restaurant = db.get(models.Restaurant, restaurant_id)
    if restaurant is None or restaurant.owner_id != user.id:
        raise HTTPException(404, "Restaurante no encontrado")
    return wallet_preview(db, "restaurant", restaurant_id)


@router.get("/admin/weekly-cut/preview")
def weekly_cut_preview(
    week_start: date,
    _: models.User = Depends(require_role("admin")),
    db: Session = Depends(get_db),
):
    """Week starting Monday in Tala/Jalisco; strictly read-only."""
    ensure_enabled()
    if week_start.weekday() != 0:
        raise HTTPException(400, "week_start debe ser lunes")
    local_zone = ZoneInfo("America/Mexico_City")
    begin = datetime.combine(week_start, time.min, local_zone).astimezone(timezone.utc)
    end = (datetime.combine(week_start, time.min, local_zone) +
           timedelta(days=7)).astimezone(timezone.utc)
    movements = db.scalars(select(models.FinanceV2WalletMovement).where(
        models.FinanceV2WalletMovement.created_at >= begin,
        models.FinanceV2WalletMovement.created_at < end,
    ).order_by(models.FinanceV2WalletMovement.owner_type,
               models.FinanceV2WalletMovement.owner_id)).all()
    results: dict[tuple[str, int], dict] = {}
    for m in movements:
        key = (m.owner_type, m.owner_id)
        summary = results.setdefault(key, {
            "owner_type": m.owner_type, "owner_id": m.owner_id,
            "net_change_cents": 0, "unverified_cents": 0,
            "cash_exposure_change_cents": 0,
        })
        summary["net_change_cents"] += m.amount_cents
        summary["unverified_cents"] += m.unfunded_delta_cents
        summary["cash_exposure_change_cents"] += m.cash_exposure_delta_cents
    return {
        "week_start": str(week_start),
        "week_end_exclusive": str(week_start + timedelta(days=7)),
        "time_zone": "America/Mexico_City",
        "participants": list(results.values()),
        "executed_transfers": 0,
        "payable_for_bank_transfer_cents": 0,
        "shadow_only": True,
    }
