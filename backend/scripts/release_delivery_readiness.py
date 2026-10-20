#!/usr/bin/env python3
"""Read-only, redacted F2 SMTP + Firebase delivery readiness check.

Run inside the *existing* backend/worker container only with owner approval:
  python scripts/release_delivery_readiness.py
  python scripts/release_delivery_readiness.py --with-db
No secret values, email addresses, reset links, access tokens, or FCM tokens
are emitted. Never queues mail, writes config, sends push or edits production.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

from app.config import settings


def inspect_config() -> dict:
    from app.native_push import is_configured
    result = {
        "smtp_host_configured": bool(settings.smtp_host),
        "smtp_sender_valid": bool(re.fullmatch(
            r"[^\s@]+@[^\s@]+\.[^\s@]+", settings.smtp_from_email)),
        "smtp_tls_or_ssl": bool(settings.smtp_use_tls or settings.smtp_use_ssl),
        "smtp_auth_user_configured": bool(settings.smtp_username),
        "smtp_auth_password_configured": bool(settings.smtp_password),
        "smtp_credentials_pair_consistent":
            bool(settings.smtp_username) == bool(settings.smtp_password),
        "reset_frontend_https": settings.frontend_url.startswith("https://"),
        "fcm_push_enabled_flag": bool(settings.native_push_enabled),
        "fcm_config_complete": bool(is_configured()),
        "fcm_service_account_file_exists":
            bool(settings.fcm_credentials_file and
                 Path(settings.fcm_credentials_file).is_file()),
        "fcm_project_id_configured": bool(settings.fcm_project_id),
        "fcm_token_encryption_configured": bool(settings.fcm_token_encryption_key),
    }
    result["smtp_config_preflight"] = all((
        result["smtp_host_configured"],
        result["smtp_sender_valid"],
        result["smtp_tls_or_ssl"],
        result["smtp_credentials_pair_consistent"],
        result["reset_frontend_https"],
    ))
    result["fcm_config_preflight"] = all((
        result["fcm_push_enabled_flag"], result["fcm_config_complete"],
        result["fcm_service_account_file_exists"],
    ))
    return result


def inspect_email_outbox() -> dict:
    from sqlalchemy import func, select
    from app import models
    from app.db import SessionLocal

    safe = {"pending": 0, "retry": 0, "sent": 0, "failed": 0}
    retry_maximum = 0
    # SELECT only; SQLAlchemy Session will rollback on context exit.
    with SessionLocal() as db:
        rows = db.execute(select(models.EmailOutbox.status, func.count())
                          .group_by(models.EmailOutbox.status)).all()
        for status, count in rows:
            if status in safe:
                safe[status] = int(count)
        retry_maximum = int(db.scalar(select(func.count(models.EmailOutbox.id))
            .where(models.EmailOutbox.attempts >= 5,
                   models.EmailOutbox.status != "sent")) or 0)
    return {"outbox_counts": safe, "exhausted_unsent": retry_maximum}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--with-db", action="store_true",
                        help="Solo conteos agregados SELECT de email_outbox")
    args = parser.parse_args()
    result = inspect_config()
    if args.with_db:
        result.update(inspect_email_outbox())
    print(json.dumps(result, sort_keys=True, indent=2))
    # No green claim based on config alone: require real QA delivery.
    print("CONFIG_ONLY_NOT_DELIVERY_PROOF")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
