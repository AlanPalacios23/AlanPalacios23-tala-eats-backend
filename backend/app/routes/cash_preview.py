"""Read-only cash reconciliation previews. No remittance/write endpoints.

This pilot view is not an account statement, confirmed debt, or bank balance.
It never calls Stripe, changes order state or writes financial records.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models
from ..cash_preview import project_cash_order, summarize_cash_projection
from ..db import get_read_db
from ..deps import require_role

router = APIRouter(prefix="/api/v1/cash-preview", tags=["cash-preview-read-only"])


def _window(days: int) -> tuple[datetime, datetime]:
    end = datetime.now(timezone.utc)
    return end - timedelta(days=days), end


def _orders(db: Session, start: datetime, end: datetime, *,
            limit: int, driver_id: int | None = None,
            restaurant_id: int | None = None) -> tuple[list[models.Order], bool]:
    query = select(models.Order).where(
        models.Order.status == "delivered",
        models.Order.payment_method == "cash",
        models.Order.delivered_at >= start,
        models.Order.delivered_at < end,
    )
    if driver_id is not None:
        query = query.where(
            models.Order.driver_id == driver_id,
            models.Order.order_type == "delivery",
        )
    if restaurant_id is not None:
        query = query.where(
            models.Order.restaurant_id == restaurant_id,
            models.Order.order_type == "pickup",
        )
    query = query.order_by(models.Order.delivered_at.desc(), models.Order.id.desc())
    rows = db.scalars(query.limit(limit + 1)).all()
    return rows[:limit], len(rows) > limit


def _legacy_holds(db: Session, projected: list[dict[str, Any]]) -> set[tuple[str, int]]:
    """Any old cash batch/payout makes ownership ambiguous: fail closed.

    An existing old payout is not proof of a bank transfer. We do not attempt to
    subtract it or infer what historical orders are already included.
    """
    driver_ids = {
        int(item["collector_id"]) for item in projected
        if item["collector_type"] == "driver" and item["collector_id"] is not None
    }
    restaurant_ids = {
        int(item["collector_id"]) for item in projected
        if item["collector_type"] == "restaurant" and item["collector_id"] is not None
    }
    holds: set[tuple[str, int]] = set()
    if driver_ids:
        for driver_id in db.scalars(
            select(models.CashSettlement.driver_id).where(
                models.CashSettlement.driver_id.in_(driver_ids)
            ).distinct()
        ):
            holds.add(("driver", int(driver_id)))
    for role, ids in (("driver", driver_ids), ("restaurant", restaurant_ids)):
        if not ids:
            continue
        for payee_id in db.scalars(
            select(models.Payout.payee_id).where(
                models.Payout.payee_type == role,
                models.Payout.payee_id.in_(ids),
            ).distinct()
        ):
            holds.add((role, int(payee_id)))
    return holds


def _view(db: Session, *, days: int, limit: int,
          driver_id: int | None = None, restaurant_id: int | None = None) -> dict[str, Any]:
    start, end = _window(days)
    orders, has_more = _orders(
        db, start, end, limit=limit,
        driver_id=driver_id, restaurant_id=restaurant_id,
    )
    projected = [project_cash_order(row) for row in orders]
    report = summarize_cash_projection(
        projected,
        has_more=has_more,
        legacy_hold_collectors=_legacy_holds(db, projected),
    )
    report["period_start_utc"] = start.isoformat()
    report["period_end_utc"] = end.isoformat()
    report["collection_rules"] = (
        "PROVISIONAL: driver collects home delivery cash; "
        "restaurant collects pickup cash. Subject to signed agreements."
    )
    return report


@router.get("/admin")
def admin_preview(
    days: int = Query(default=7, ge=1, le=31),
    limit: int = Query(default=100, ge=1, le=200),
    _: models.User = Depends(require_role("admin")),
    db: Session = Depends(get_read_db),
) -> dict[str, Any]:
    return _view(db, days=days, limit=limit)


@router.get("/driver/me")
def driver_preview(
    days: int = Query(default=7, ge=1, le=31),
    limit: int = Query(default=100, ge=1, le=200),
    user: models.User = Depends(require_role("driver")),
    db: Session = Depends(get_read_db),
) -> dict[str, Any]:
    return _view(db, days=days, limit=limit, driver_id=user.id)


@router.get("/restaurant/me")
def restaurant_preview(
    days: int = Query(default=7, ge=1, le=31),
    limit: int = Query(default=100, ge=1, le=200),
    user: models.User = Depends(require_role("restaurant")),
    db: Session = Depends(get_read_db),
) -> dict[str, Any]:
    restaurant_id = db.scalar(
        select(models.Restaurant.id).where(models.Restaurant.owner_id == user.id).limit(1)
    )
    if restaurant_id is None:
        raise HTTPException(404, "No hay restaurante asociado a esta cuenta")
    return _view(db, days=days, limit=limit, restaurant_id=int(restaurant_id))
