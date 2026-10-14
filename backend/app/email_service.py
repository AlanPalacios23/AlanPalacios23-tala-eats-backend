from __future__ import annotations

import smtplib
from email.message import EmailMessage
from email.utils import formataddr

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .config import settings


def enqueue_email(db: Session, to_email: str, subject: str, text_body: str) -> models.EmailOutbox:
    row = models.EmailOutbox(to_email=to_email.strip().lower(), subject=subject[:220], text_body=text_body)
    db.add(row)
    db.flush()
    return row


def _smtp_connection():
    if settings.smtp_use_ssl:
        client = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15)
    else:
        client = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15)
        if settings.smtp_use_tls:
            client.starttls()
    if settings.smtp_username:
        client.login(settings.smtp_username, settings.smtp_password)
    return client


def send_pending_emails(db: Session, limit: int = 20) -> tuple[int, int]:
    rows = db.scalars(
        select(models.EmailOutbox)
        .where(models.EmailOutbox.status.in_(["pending", "retry"]), models.EmailOutbox.attempts < 5)
        .order_by(models.EmailOutbox.created_at)
        .limit(limit)
        .with_for_update(skip_locked=True)
    ).all()
    if not rows or not settings.smtp_host:
        return 0, 0

    from datetime import datetime, timezone

    sent = failed = 0
    try:
        client = _smtp_connection()
    except Exception as exc:
        error = str(exc)[:500]
        for row in rows:
            row.attempts += 1
            row.status = "retry"
            row.last_error = error
            failed += 1
        db.commit()
        return sent, failed

    try:
        for row in rows:
            row.attempts += 1
            try:
                msg = EmailMessage()
                msg["From"] = formataddr((settings.smtp_from_name, settings.smtp_from_email))
                msg["To"] = row.to_email
                msg["Subject"] = row.subject
                msg.set_content(row.text_body)
                client.send_message(msg)
                row.status = "sent"
                row.sent_at = datetime.now(timezone.utc)
                row.last_error = ""
                sent += 1
            except Exception as exc:
                row.status = "retry"
                row.last_error = str(exc)[:500]
                failed += 1
    finally:
        try:
            client.quit()
        except Exception:
            try:
                client.close()
            except Exception:
                pass
    db.commit()
    return sent, failed
