"""F2.06 SMTP transport evidence is never proof of human acknowledgement.

Offline SQLite-only regression suite. All SMTP connections are replaced by
in-process fake transports; no contact details, credentials or network.
"""
from sqlalchemy import select

from app import models
from app.alerting import upsert_alert
from app.config import settings
from app.db import SessionLocal
from app import email_service


def queue(db, suffix):
    alert = upsert_alert(db, "qa.f206.smtp." + suffix, "critical", "transportqa",
                         "Synthetic alert only - no actual incident", {"qa": True})
    db.commit()
    mail = db.scalar(select(models.EmailOutbox).where(
        models.EmailOutbox.subject.contains("transportqa")))
    assert mail is not None
    assert alert.notified_at is None
    assert mail.status == "pending"
    return alert, mail


def enable_synthetic_smtp(monkeypatch):
    monkeypatch.setattr(settings, "smtp_host", "synthetic.invalid")
    monkeypatch.setattr(settings, "smtp_from_email", "qa-no-reply@example.invalid")
    monkeypatch.setattr(settings, "smtp_from_name", "TALA EATS QA")


class FakeSmtp:
    def __init__(self, *, fail=False):
        self.fail = fail
        self.sent = []
        self.closed = False

    def send_message(self, message):
        if self.fail:
            raise ConnectionError("sensitive-synthetic-host-info MUST NOT be persisted")
        self.sent.append(message)

    def quit(self):
        self.closed = True


def test_successful_smtp_send_is_not_human_receipt(monkeypatch):
    enable_synthetic_smtp(monkeypatch)
    fake = FakeSmtp()
    monkeypatch.setattr(email_service, "_smtp_connection", lambda: fake)
    with SessionLocal() as db:
        alert, mail = queue(db, "transport_sent")
        sent, failed = email_service.send_pending_emails(db)
        db.refresh(alert)
        db.refresh(mail)
        assert sent >= 1 and failed == 0
        assert mail.status == "sent" and mail.sent_at is not None
        assert mail.attempts == 1 and mail.last_error == ""
        assert fake.sent and fake.closed
        assert alert.notified_at is None, "SMTP acceptance is not 24/7 human ACK"


def test_smtp_connection_exception_fails_closed_and_redacts_message(monkeypatch):
    enable_synthetic_smtp(monkeypatch)
    def unavailable():
        raise OSError("synthetic-password-or-user-identifiers MUST NOT appear")
    monkeypatch.setattr(email_service, "_smtp_connection", unavailable)
    with SessionLocal() as db:
        alert, mail = queue(db, "connect_error")
        sent, failed = email_service.send_pending_emails(db)
        db.refresh(alert)
        db.refresh(mail)
        assert sent == 0 and failed >= 1
        assert mail.status == "retry" and mail.sent_at is None
        assert mail.attempts == 1
        assert mail.last_error == "smtp_connection_error:OSError"
        assert "synthetic-password" not in mail.last_error
        assert alert.notified_at is None


def test_delivery_exception_does_not_mark_sent_or_leak_error(monkeypatch):
    enable_synthetic_smtp(monkeypatch)
    fake = FakeSmtp(fail=True)
    monkeypatch.setattr(email_service, "_smtp_connection", lambda: fake)
    with SessionLocal() as db:
        alert, mail = queue(db, "delivery_error")
        sent, failed = email_service.send_pending_emails(db)
        db.refresh(alert)
        db.refresh(mail)
        assert sent == 0 and failed >= 1
        assert mail.status == "retry" and mail.sent_at is None
        assert mail.last_error == "smtp_delivery_error:ConnectionError"
        assert "sensitive-synthetic" not in mail.last_error
        assert fake.closed
        assert alert.notified_at is None


def test_exhausted_retries_remain_unconfirmed(monkeypatch):
    enable_synthetic_smtp(monkeypatch)
    fake = FakeSmtp()
    monkeypatch.setattr(email_service, "_smtp_connection", lambda: fake)
    with SessionLocal() as db:
        alert, mail = queue(db, "retry_limit")
        mail.status = "retry"
        mail.attempts = 5
        db.commit()
        email_service.send_pending_emails(db)
        db.refresh(alert)
        db.refresh(mail)
        assert mail.attempts == 5
        assert mail.status == "retry" and mail.sent_at is None
        assert alert.notified_at is None
        assert not any("transportqa" in str(message["Subject"]) for message in fake.sent)
