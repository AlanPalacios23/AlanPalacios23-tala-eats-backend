from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import models
from .config import settings


def evaluate_order_risk(db: Session, order: models.Order) -> tuple[int, list[str]]:
    """Small explainable rules engine designed to be replaced/augmented later.

    It never blocks an order by itself; it creates review signals. This keeps fraud
    controls observable without turning a false positive into an outage.
    """
    now = datetime.now(timezone.utc)
    score = 0
    signals: list[str] = []
    hour_ago = now - timedelta(hours=1)
    thirty_days = now - timedelta(days=30)
    velocity = db.scalar(select(func.count(models.Order.id)).where(models.Order.user_id == order.user_id, models.Order.created_at >= hour_ago)) or 0
    refunds = db.scalar(select(func.count(models.RefundAdjustment.id)).join(models.Order, models.Order.id == models.RefundAdjustment.order_id).where(models.Order.user_id == order.user_id, models.RefundAdjustment.created_at >= thirty_days, models.RefundAdjustment.status.in_(("completed", "processed", "refunded")))) or 0
    if velocity >= settings.fraud_velocity_orders_per_hour:
        score += 45; signals.append("order_velocity")
    if refunds >= settings.fraud_refunds_30d_threshold:
        score += 35; signals.append("refund_velocity")
    if Decimal(order.total or 0) >= Decimal("1500"):
        score += 20; signals.append("high_value")
    if order.delivery_lat is None or order.delivery_lng is None:
        score += 10; signals.append("missing_precise_location")
    return min(score, 100), signals


def flag_order_if_needed(db: Session, order: models.Order) -> int:
    score, signals = evaluate_order_risk(db, order)
    if score < 35:
        return score
    severity = "critical" if score >= 80 else "high" if score >= 60 else "medium"
    reason = "Señales antifraude: " + ", ".join(signals)
    existing = db.scalar(select(models.FraudFlag.id).where(models.FraudFlag.order_id == order.id, models.FraudFlag.signal == "v14_order_risk", models.FraudFlag.resolved.is_(False)))
    if not existing:
        db.add(models.FraudFlag(user_id=order.user_id, order_id=order.id, reason=reason[:300], severity=severity, risk_score=score, signal="v14_order_risk"))
    return score
