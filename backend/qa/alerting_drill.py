"""Alert persistence/notification/resolution contract against disposable QA Postgres.

No SMTP worker, no live customers, no financial settlement.
"""
import os
import uuid
from sqlalchemy import select, func
from app import models
from app.alerting import evaluate_system_alerts
from app.config import settings
from app.db import SessionLocal

def main():
    assert os.environ.get("DATABASE_URL") == (
        "postgresql+psycopg://talaqa:qa-only-local@127.0.0.1:5432/talaqa")
    assert settings.environment == "development"
    assert not settings.stripe_enabled and not settings.withdrawals_execution_enabled
    key = "qa-alert-" + uuid.uuid4().hex
    old_threshold = settings.alert_outbox_backlog
    try:
        settings.alert_outbox_backlog = 1
        with SessionLocal() as db:
            synthetic = models.EventOutbox(
                event_key=key, aggregate_type="qa", aggregate_id="0",
                event_type="qa.alert", payload_json="{}", status="pending")
            db.add(synthetic)
            db.commit()

            snapshot = evaluate_system_alerts(db)
            assert snapshot["outbox_backlog"] >= 1
            alert = db.scalar(select(models.SystemAlert).where(
                models.SystemAlert.alert_key == "outbox.backlog",
                models.SystemAlert.status == "open"))
            assert alert and alert.severity == "critical", "No persisted critical alert"
            emails = db.scalar(select(func.count(models.EmailOutbox.id)).where(
                models.EmailOutbox.subject.like("%TALA EATS%")))
            assert emails >= 1, "No queued admin notification"
            # IMPORTANT: no worker or SMTP runs during this drill.
            for event in db.scalars(select(models.EventOutbox).where(
                    models.EventOutbox.status.in_(("pending", "retry")))).all():
                event.status = "published"
            db.commit()

            resumed = evaluate_system_alerts(db)
            assert resumed["outbox_backlog"] == 0, resumed
            db.refresh(alert)
            assert alert.status == "resolved", "Alert did not close after recovery"
            print("ALERTING_QA_PASS persistent critical alert, queued email, recovery resolution")
    finally:
        settings.alert_outbox_backlog = old_threshold

if __name__ == "__main__":
    main()
