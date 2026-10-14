from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from . import models
from .config import settings
from .realtime import publish_order_event
from .cache import bump_catalog_version

log = logging.getLogger("talaeats.outbox")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def enqueue_event(
    db: Session,
    *,
    event_key: str,
    aggregate_type: str,
    aggregate_id: str | int,
    event_type: str,
    payload: dict[str, Any] | None = None,
) -> models.EventOutbox:
    row = models.EventOutbox(
        event_key=event_key[:220],
        aggregate_type=aggregate_type[:60],
        aggregate_id=str(aggregate_id)[:120],
        event_type=event_type[:120],
        payload_json=json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":"), default=str),
    )
    db.add(row)
    return row


def _publish(row: models.EventOutbox) -> None:
    payload = json.loads(row.payload_json or "{}")
    if row.aggregate_type == "order" and row.aggregate_id.isdigit():
        publish_order_event(int(row.aggregate_id), row.event_type, payload)
    elif row.event_type == "catalog.changed":
        bump_catalog_version()
    # Non-order events remain durable for analytics/integrations. Provider-specific
    # consumers can be added without changing the transaction that produced them.


def process_outbox(db: Session, *, limit: int | None = None) -> tuple[int, int, int]:
    """Publish durable domain events with bounded retries and DLQ handoff.

    Returns (published, retried, dead_lettered). Rows are claimed with SKIP LOCKED
    on PostgreSQL so multiple future workers can safely drain the queue.
    """
    instant = utcnow()
    batch = max(1, min(limit or settings.outbox_batch_size, settings.outbox_batch_size))
    stmt = (
        select(models.EventOutbox)
        .where(
            models.EventOutbox.status.in_(("pending", "retry")),
            or_(models.EventOutbox.next_attempt_at.is_(None), models.EventOutbox.next_attempt_at <= instant),
        )
        .order_by(models.EventOutbox.created_at, models.EventOutbox.id)
        .limit(batch)
    )
    if db.bind and db.bind.dialect.name != "sqlite":
        stmt = stmt.with_for_update(skip_locked=True)
    rows = db.scalars(stmt).all()
    published = retried = dead = 0
    for row in rows:
        row.locked_at = instant
        row.attempts = int(row.attempts or 0) + 1
        try:
            _publish(row)
            row.status = "published"
            row.published_at = utcnow()
            row.last_error = ""
            published += 1
        except Exception as exc:
            row.last_error = str(exc)[:1000]
            if row.attempts >= settings.outbox_max_attempts:
                row.status = "dead"
                db.add(
                    models.DeadLetterJob(
                        source="event_outbox",
                        source_id=str(row.id),
                        kind=row.event_type,
                        payload_json=row.payload_json,
                        error=row.last_error,
                        attempts=row.attempts,
                    )
                )
                dead += 1
                log.exception("outbox event moved to DLQ id=%s type=%s", row.id, row.event_type)
            else:
                row.status = "retry"
                delay = min(3600, settings.outbox_retry_base_seconds * (2 ** min(row.attempts - 1, 8)))
                row.next_attempt_at = utcnow() + timedelta(seconds=delay)
                retried += 1
                log.exception("outbox event retry id=%s type=%s attempt=%s", row.id, row.event_type, row.attempts)
    if rows:
        db.commit()
    return published, retried, dead


def retry_dead_letter(db: Session, dlq_id: int) -> models.EventOutbox:
    dlq = db.get(models.DeadLetterJob, dlq_id)
    if not dlq or dlq.status != "open":
        raise ValueError("DLQ no disponible")
    key = f"dlq-retry:{dlq.id}:{int(utcnow().timestamp())}"
    row = enqueue_event(
        db,
        event_key=key,
        aggregate_type="order" if dlq.kind.startswith(("order.", "payment.", "driver.")) else "system",
        aggregate_id=(json.loads(dlq.payload_json or "{}").get("order_id") or dlq.source_id),
        event_type=dlq.kind,
        payload=json.loads(dlq.payload_json or "{}"),
    )
    dlq.status = "retried"
    dlq.resolved_at = utcnow()
    db.commit()
    db.refresh(row)
    return row
