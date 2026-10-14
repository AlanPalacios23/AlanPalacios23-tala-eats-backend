from __future__ import annotations

import hashlib
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models


def enabled(db: Session, key: str, *, user_id: int | None = None, role: str = "all", default: bool = False) -> bool:
    row = db.scalar(select(models.FeatureFlag).where(models.FeatureFlag.key == key))
    if not row:
        return default
    if not row.enabled:
        return False
    if row.audience_role not in {"all", role}:
        return False
    rollout = max(0, min(100, int(row.rollout_percent or 0)))
    if rollout >= 100:
        return True
    if rollout <= 0:
        return False
    seed = f"{key}:{user_id or 0}".encode()
    bucket = int.from_bytes(hashlib.sha256(seed).digest()[:4], "big") % 100
    return bucket < rollout
