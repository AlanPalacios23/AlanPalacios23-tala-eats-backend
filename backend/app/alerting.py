from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import models
from .config import settings
from .middleware import runtime_metrics
from .email_service import enqueue_email
from .distributed_metrics import snapshot as distributed_metrics_snapshot


def now():
    return datetime.now(timezone.utc)


def upsert_alert(db: Session, key: str, severity: str, component: str, message: str, detail: dict) -> models.SystemAlert:
    row = db.scalar(select(models.SystemAlert).where(models.SystemAlert.alert_key == key, models.SystemAlert.status == "open").order_by(models.SystemAlert.last_seen_at.desc()).limit(1))
    instant = now()
    if row:
        row.severity = severity
        row.component = component
        row.message = message[:500]
        row.detail_json = json.dumps(detail, ensure_ascii=False, default=str)[:10000]
        row.last_seen_at = instant
        return row
    row = models.SystemAlert(alert_key=key[:160], severity=severity, component=component[:60], message=message[:500], detail_json=json.dumps(detail, ensure_ascii=False, default=str)[:10000], first_seen_at=instant, last_seen_at=instant)
    db.add(row)
    if severity in {"high", "critical"}:
        admins = db.execute(select(models.User.email, models.User.name).where(models.User.role == "admin", models.User.is_active.is_(True))).all()
        for email, name in admins:
            enqueue_email(db, email, f"[TALA EATS] Alerta {severity.upper()}: {component}", f"Hola {name},\n\n{message}\n\nDetalle: {json.dumps(detail, ensure_ascii=False, default=str)}\n\nRevisa /api/v1/resilience/status y /alerts.")
        row.notified_at = instant if admins else None
    return row


def resolve_alert(db: Session, key: str) -> None:
    instant = now()
    for row in db.scalars(select(models.SystemAlert).where(models.SystemAlert.alert_key == key, models.SystemAlert.status == "open")).all():
        row.status = "resolved"
        row.resolved_at = instant
        row.last_seen_at = instant


def evaluate_system_alerts(db: Session) -> dict[str, int]:
    outbox = db.scalar(select(func.count(models.EventOutbox.id)).where(models.EventOutbox.status.in_(("pending", "retry")))) or 0
    dlq = db.scalar(select(func.count(models.DeadLetterJob.id)).where(models.DeadLetterJob.status == "open")) or 0
    mismatches = db.scalar(select(func.count(models.PaymentReconciliation.id)).where(models.PaymentReconciliation.status == "mismatch", models.PaymentReconciliation.created_at >= now() - timedelta(hours=24))) or 0
    critical_incidents = db.scalar(select(func.count(models.OperationalIncident.id)).where(models.OperationalIncident.status == "open", models.OperationalIncident.severity.in_(("high", "critical")))) or 0
    runtime = runtime_metrics.snapshot()
    distributed = distributed_metrics_snapshot()
    if distributed.get("available") and distributed.get("requests", 0):
        metric_requests = int(distributed.get("requests", 0))
        error_rate = float(distributed.get("error_rate_percent") or 0)
        p95_ms = float(distributed.get("p95_ms") or 0)
    else:
        metric_requests = int(runtime.get("window_requests", 0))
        error_rate = float(runtime.get("error_rate_percent") or 0)
        p95_ms = float(runtime.get("p95_ms") or 0)

    if outbox >= settings.alert_outbox_backlog:
        upsert_alert(db, "outbox.backlog", "critical", "outbox", "El outbox durable acumuló demasiados eventos", {"backlog": outbox, "threshold": settings.alert_outbox_backlog})
    else:
        resolve_alert(db, "outbox.backlog")
    if dlq:
        upsert_alert(db, "dlq.open", "high", "worker", "Hay trabajos en Dead Letter Queue que requieren revisión", {"open": dlq})
    else:
        resolve_alert(db, "dlq.open")
    if mismatches:
        upsert_alert(db, "payments.reconciliation", "high", "payments", "La conciliación detectó diferencias con el proveedor", {"mismatches_24h": mismatches})
    else:
        resolve_alert(db, "payments.reconciliation")
    if critical_incidents:
        upsert_alert(db, "operations.critical", "high", "operations", "Hay incidentes operativos de prioridad alta", {"open": critical_incidents})
    else:
        resolve_alert(db, "operations.critical")
    if metric_requests >= 50 and error_rate >= settings.alert_error_rate_percent:
        upsert_alert(db, "slo.error_rate", "critical", "api", "La tasa de errores 5xx superó el SLO", {"error_rate_percent": error_rate, "threshold": settings.alert_error_rate_percent})
    else:
        resolve_alert(db, "slo.error_rate")
    if metric_requests >= 50 and p95_ms >= settings.alert_p95_ms:
        upsert_alert(db, "slo.p95_latency", "high", "api", "La latencia p95 superó el SLO", {"p95_ms": p95_ms, "threshold_ms": settings.alert_p95_ms})
    else:
        resolve_alert(db, "slo.p95_latency")
    db.commit()
    return {"outbox_backlog": int(outbox), "dlq_open": int(dlq), "payment_mismatches_24h": int(mismatches), "critical_incidents": int(critical_incidents), "error_rate_percent": error_rate, "p95_ms": p95_ms, "metric_requests": metric_requests}
