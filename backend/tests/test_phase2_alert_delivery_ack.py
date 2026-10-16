"""F2.06: enqueue != SMTP transport success != human acknowledgement.

All tests run in seeded SQLite without SMTP/network or production contacts.
"""
from sqlalchemy import func, select

from app import models
from app.alerting import upsert_alert
from app.db import SessionLocal
from app.email_service import send_pending_emails
from app.config import settings


def test_critical_queued_email_does_not_mark_alert_delivered():
    with SessionLocal() as db:
        admin = db.scalar(select(models.User).where(
            models.User.role == "admin", models.User.is_active.is_(True)))
        assert admin is not None
        alert = upsert_alert(db, "qa.f206.queued.critical", "critical",
                             "payments", "QA only no financial changes", {"synthetic": True})
        db.commit()
        db.refresh(alert)
        mail = db.scalars(select(models.EmailOutbox).where(
            models.EmailOutbox.to_email == admin.email.lower().strip()
        )).all()
        assert mail
        assert all(item.status == "pending" and item.sent_at is None for item in mail)
        assert alert.notified_at is None, "Queue must not falsely imply delivery"


def test_repeated_high_alert_does_not_fabricate_receipt_or_duplicate_open_alert():
    with SessionLocal() as db:
        first = upsert_alert(db, "qa.f206.repeated", "high", "worker",
                             "Synthetic DLQ", {"open": 2})
        db.commit()
        db.refresh(first)
        identifier = first.id
        second = upsert_alert(db, "qa.f206.repeated", "high", "worker",
                              "Synthetic DLQ", {"open": 3})
        db.commit()
        db.refresh(second)
        assert second.id == identifier
        assert second.notified_at is None
        assert db.scalar(select(func.count(models.SystemAlert.id)).where(
            models.SystemAlert.alert_key == "qa.f206.repeated",
            models.SystemAlert.status == "open")) == 1


def test_no_active_admin_means_no_email_and_no_claimed_delivery():
    with SessionLocal() as db:
        admins = db.scalars(select(models.User).where(models.User.role == "admin")).all()
        assert admins
        for admin in admins:
            admin.is_active = False
        db.flush()
        alert = upsert_alert(db, "qa.f206.no.guard", "critical", "api",
                             "QA simulated incident", {"mode": "test"})
        db.commit()
        db.refresh(alert)
        assert alert.notified_at is None
        assert db.scalar(select(func.count(models.EmailOutbox.id))) == 0


def test_no_smtp_configuration_does_not_complete_delivery(monkeypatch):
    monkeypatch.setattr(settings, "smtp_host", "")
    with SessionLocal() as db:
        alert = upsert_alert(db, "qa.f206.no.smtp", "high", "api",
                             "QA outage", {})
        db.commit()
        sent, failed = send_pending_emails(db, limit=20)
        db.refresh(alert)
        assert sent == failed == 0
        assert alert.notified_at is None
        assert db.scalar(select(func.count(models.EmailOutbox.id)).where(
            models.EmailOutbox.status == "pending")) >= 1
