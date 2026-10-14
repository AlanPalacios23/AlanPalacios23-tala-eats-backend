from __future__ import annotations

import logging
from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings

log = logging.getLogger("talaeats.postgis")


def postgis_available(db: Session) -> bool:
    if not settings.postgis_enabled or not db.bind or db.bind.dialect.name != "postgresql":
        return False
    try:
        return bool(db.scalar(text("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='postgis')")))
    except Exception:
        return False


def nearest_online_driver_ids(db: Session, lat: float, lng: float, *, radius_km: float = 25.0, limit: int = 100) -> list[int] | None:
    """Return a PostGIS-indexable shortlist, or None to request Python fallback."""
    if not postgis_available(db):
        return None
    try:
        rows = db.execute(text("""
            SELECT dp.user_id
            FROM driver_profiles dp
            JOIN users u ON u.id = dp.user_id
            WHERE u.role = 'driver' AND u.is_active = true
              AND dp.is_online = true AND dp.is_verified = true
              AND dp.current_lat IS NOT NULL AND dp.current_lng IS NOT NULL
              AND ST_DWithin(
                ST_SetSRID(ST_MakePoint(dp.current_lng, dp.current_lat),4326)::geography,
                ST_SetSRID(ST_MakePoint(:lng, :lat),4326)::geography,
                :radius_m
              )
            ORDER BY ST_Distance(
                ST_SetSRID(ST_MakePoint(dp.current_lng, dp.current_lat),4326)::geography,
                ST_SetSRID(ST_MakePoint(:lng, :lat),4326)::geography
            )
            LIMIT :limit
        """), {"lat": float(lat), "lng": float(lng), "radius_m": float(radius_km) * 1000.0, "limit": max(1, min(limit, 500))}).all()
        return [int(row[0]) for row in rows]
    except Exception:
        log.exception("PostGIS shortlist failed; using haversine fallback")
        return None
