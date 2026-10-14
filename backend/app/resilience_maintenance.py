from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from . import models
from .config import settings


def _utcnow():
    return datetime.now(timezone.utc)


def _delete_bounded(db: Session, model, where, *, limit: int) -> int:
    ids = db.scalars(select(model.id).where(*where).order_by(model.id).limit(max(1, min(limit, 5000)))).all()
    if not ids:
        return 0
    result = db.execute(delete(model).where(model.id.in_(ids)))
    return int(result.rowcount or len(ids))


def cleanup_resilience_history(db: Session, *, limit: int = 2000) -> dict[str, int]:
    """Bounded retention for derived operational data.

    Immutable financial ledger and audit/order history are deliberately excluded.
    Only already-published outbox rows, old reconciliation observations and resolved
    alerts are eligible for deletion.
    """
    now = _utcnow()
    outbox = _delete_bounded(
        db, models.EventOutbox,
        (models.EventOutbox.status == "published", models.EventOutbox.published_at < now - timedelta(days=settings.outbox_retention_days)),
        limit=limit,
    )
    reconciliations = _delete_bounded(
        db, models.PaymentReconciliation,
        (models.PaymentReconciliation.created_at < now - timedelta(days=settings.reconciliation_retention_days),),
        limit=limit,
    )
    alerts = _delete_bounded(
        db, models.SystemAlert,
        (models.SystemAlert.status == "resolved", models.SystemAlert.resolved_at < now - timedelta(days=settings.resolved_alert_retention_days)),
        limit=limit,
    )
    db.commit()
    return {"outbox": outbox, "reconciliations": reconciliations, "resolved_alerts": alerts}
