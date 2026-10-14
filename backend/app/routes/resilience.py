from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import models
from ..alerting import evaluate_system_alerts
from ..config import settings
from ..db import get_db
from ..deps import require_role
from ..http_client import circuit_breaker_snapshot
from ..geo_postgis import postgis_available
from ..middleware import runtime_metrics
from ..distributed_metrics import snapshot as distributed_metrics_snapshot
from ..outbox import process_outbox, retry_dead_letter
from ..reconciliation import reconcile_mercadopago
from ..resilience_maintenance import cleanup_resilience_history

router = APIRouter(prefix="/api/v1/resilience", tags=["core-resilience-v14"])


@router.get("/status")
def resilience_status(_: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    metrics = runtime_metrics.snapshot()
    return {
        "version": "1.4.0-core-resilience",
        "state_machine": "global-sqlalchemy-guard",
        "outbox": {
            "pending": db.scalar(select(func.count(models.EventOutbox.id)).where(models.EventOutbox.status.in_(("pending", "retry")))) or 0,
            "dead": db.scalar(select(func.count(models.EventOutbox.id)).where(models.EventOutbox.status == "dead")) or 0,
        },
        "dlq_open": db.scalar(select(func.count(models.DeadLetterJob.id)).where(models.DeadLetterJob.status == "open")) or 0,
        "payment_mismatches_24h": db.scalar(select(func.count(models.PaymentReconciliation.id)).where(models.PaymentReconciliation.status == "mismatch")) or 0,
        "open_alerts": db.scalar(select(func.count(models.SystemAlert.id)).where(models.SystemAlert.status == "open")) or 0,
        "runtime": metrics,
        "distributed_runtime": distributed_metrics_snapshot(),
        "circuit_breakers": circuit_breaker_snapshot(),
    }


@router.get("/alerts")
def alerts(_: models.User = Depends(require_role("admin")), db: Session = Depends(get_db), limit: int = 100):
    rows = db.scalars(select(models.SystemAlert).order_by(models.SystemAlert.last_seen_at.desc()).limit(max(1, min(limit, 500)))).all()
    return [{"id": r.id, "key": r.alert_key, "severity": r.severity, "component": r.component, "message": r.message, "detail_json": r.detail_json, "status": r.status, "first_seen_at": r.first_seen_at, "last_seen_at": r.last_seen_at, "notified_at": r.notified_at} for r in rows]


@router.get("/dlq")
def dlq(_: models.User = Depends(require_role("admin")), db: Session = Depends(get_db), limit: int = 100):
    rows = db.scalars(select(models.DeadLetterJob).order_by(models.DeadLetterJob.created_at.desc()).limit(max(1, min(limit, 500)))).all()
    return [{"id": r.id, "source": r.source, "source_id": r.source_id, "kind": r.kind, "error": r.error, "attempts": r.attempts, "status": r.status, "created_at": r.created_at} for r in rows]


@router.post("/dlq/{dlq_id}/retry")
def dlq_retry(dlq_id: int, _: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    try:
        row = retry_dead_letter(db, dlq_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"outbox_id": row.id, "status": row.status}


@router.post("/outbox/drain")
def outbox_drain(_: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    published, retried, dead = process_outbox(db)
    return {"published": published, "retried": retried, "dead_lettered": dead}


@router.post("/payments/reconcile")
def payment_reconcile(_: models.User = Depends(require_role("admin")), db: Session = Depends(get_db), limit: int = 100):
    checked, repaired, mismatched = reconcile_mercadopago(db, limit=max(1, min(limit, 500)))
    return {"checked": checked, "repaired": repaired, "mismatched": mismatched}


@router.post("/alerts/evaluate")
def alert_evaluate(_: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    return evaluate_system_alerts(db)


@router.get("/ledger/balance")
def ledger_balance(_: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    rows = db.execute(select(models.FinancialLedgerEntry.account, models.FinancialLedgerEntry.direction, func.coalesce(func.sum(models.FinancialLedgerEntry.amount), 0)).group_by(models.FinancialLedgerEntry.account, models.FinancialLedgerEntry.direction)).all()
    balances: dict[str, float] = {}
    for account, direction, amount in rows:
        signed = float(amount or 0) * (1 if direction == "credit" else -1)
        balances[account] = round(balances.get(account, 0.0) + signed, 2)
    return {"append_only": True, "balances": balances}


@router.get("/slo")
def slo(_: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    local_metrics = runtime_metrics.snapshot()
    distributed = distributed_metrics_snapshot()
    metrics = distributed if distributed.get("available") and distributed.get("requests", 0) else {
        "requests": local_metrics.get("window_requests", 0),
        "error_rate_percent": local_metrics.get("error_rate_percent", 0),
        "p95_ms": local_metrics.get("p95_ms", 0),
    }
    error_ok = float(metrics.get("error_rate_percent") or 0) < settings.alert_error_rate_percent
    latency_ok = float(metrics.get("p95_ms") or 0) < settings.alert_p95_ms
    outbox_backlog = db.scalar(select(func.count(models.EventOutbox.id)).where(models.EventOutbox.status.in_(("pending", "retry")))) or 0
    backlog_ok = int(outbox_backlog) < settings.alert_outbox_backlog
    return {
        "healthy": bool(error_ok and latency_ok and backlog_ok),
        "window_requests": metrics.get("requests", metrics.get("window_requests", 0)),
        "error_rate_percent": metrics.get("error_rate_percent", 0),
        "error_rate_threshold_percent": settings.alert_error_rate_percent,
        "p95_ms": metrics.get("p95_ms", 0),
        "p95_threshold_ms": settings.alert_p95_ms,
        "outbox_backlog": int(outbox_backlog),
        "outbox_backlog_threshold": settings.alert_outbox_backlog,
    }


@router.get("/infrastructure")
def infrastructure(_: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    return {
        "read_replica_configured": bool(settings.read_database_url),
        "postgis_configured": settings.postgis_enabled,
        "postgis_available": postgis_available(db),
        "pitr_configured": settings.pitr_enabled,
        "otel_configured": bool(settings.otel_endpoint),
        "immutable_ledger": settings.immutable_ledger,
    }


@router.post("/retention/run")
def retention_run(_: models.User = Depends(require_role("admin")), db: Session = Depends(get_db), limit: int = 2000):
    return cleanup_resilience_history(db, limit=max(1, min(limit, 5000)))
