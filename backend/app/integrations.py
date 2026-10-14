from __future__ import annotations

import hashlib
import hmac
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any


from .config import settings
from .geo import haversine_km
from .http_client import get as http_get, post as http_post

log = logging.getLogger("talaeats.integrations")


@dataclass
class ProviderResult:
    ok: bool
    status: str
    provider_ref: str = ""
    detail: str = ""
    raw: dict[str, Any] | None = None


def integration_status() -> dict[str, dict[str, Any]]:
    web_push_ready = bool(settings.web_push_vapid_public_key and settings.web_push_vapid_private_key)
    maps_ready = bool(settings.maps_api_key or settings.maps_geocode_url or settings.maps_directions_url)
    payout_ready = settings.payout_provider != "manual" and bool(settings.payout_api_url and settings.payout_api_token)
    return {
        "payments": {
            "provider": settings.payment_provider,
            "configured": bool(settings.mercado_pago_access_token and settings.mercado_pago_webhook_secret) if settings.payment_provider == "mercadopago" else False,
        },
        "payouts": {"provider": settings.payout_provider, "configured": payout_ready},
        "web_push": {"provider": "webpush-vapid", "configured": web_push_ready},
        "maps": {"provider": settings.maps_provider, "configured": maps_ready, "fallback": "haversine"},
        "smtp": {"provider": "smtp", "configured": bool(settings.smtp_host)},
        "google_oauth": {"provider": "google", "configured": bool(settings.google_client_id)},
        "observability": {"provider": "otlp", "configured": bool(settings.otel_endpoint)},
    }


def send_web_push(subscription: dict[str, Any], title: str, body: str, *, url: str = "/") -> ProviderResult:
    if not (settings.web_push_vapid_public_key and settings.web_push_vapid_private_key):
        return ProviderResult(False, "not_configured", detail="VAPID no configurado")
    try:
        from pywebpush import webpush, WebPushException
    except Exception:
        return ProviderResult(False, "dependency_missing", detail="Instala pywebpush para habilitar Web Push")
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps({"title": title, "body": body, "url": url, "icon": "/icons/icon-192.png"}, ensure_ascii=False),
            vapid_private_key=settings.web_push_vapid_private_key,
            vapid_claims={"sub": settings.web_push_subject},
            timeout=8,
        )
        return ProviderResult(True, "sent")
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        return ProviderResult(False, "gone" if status in {404, 410} else "failed", detail=str(exc)[:500])
    except Exception as exc:
        return ProviderResult(False, "failed", detail=str(exc)[:500])


def dispatch_payout(payload: dict[str, Any]) -> ProviderResult:
    """Dispatch a payout through a deliberately provider-neutral HTTP adapter.

    V11 does not pretend every bank provider shares one API. In production the
    configured payout gateway/adapter receives a stable Tala Eats contract and
    translates it to the selected bank/fintech API. Manual mode is explicit.
    """
    if settings.payout_provider == "manual":
        return ProviderResult(False, "manual", detail="Payout queda listo para conciliación manual")
    if settings.payout_provider != "http" or not settings.payout_api_url or not settings.payout_api_token:
        return ProviderResult(False, "not_configured", detail="Proveedor de payouts no configurado")
    headers = {
        "Authorization": f"Bearer {settings.payout_api_token}",
        "Content-Type": "application/json",
        "Idempotency-Key": str(payload.get("idempotency_key") or f"payout-{payload.get('payout_id')}")[:180],
        "X-TalaEats-Version": settings.app_version,
    }
    try:
        response = http_post(settings.payout_api_url, headers=headers, json=payload, timeout=15)
        data = response.json() if "json" in response.headers.get("content-type", "") else {}
        if response.status_code >= 400:
            return ProviderResult(False, "failed", detail=(data.get("message") or response.text or "Proveedor rechazó payout")[:500], raw=data)
        ref = str(data.get("id") or data.get("reference") or data.get("provider_ref") or "")[:180]
        status = str(data.get("status") or "processing")[:30]
        return ProviderResult(True, status, provider_ref=ref, raw=data)
    except Exception as exc:
        return ProviderResult(False, "failed", detail=str(exc)[:500])


def verify_payout_webhook(body: bytes, signature: str | None) -> bool:
    if not settings.payout_webhook_secret:
        return not settings.is_production
    if not signature:
        return False
    expected = hmac.new(settings.payout_webhook_secret.encode(), body, hashlib.sha256).hexdigest()
    supplied = signature.removeprefix("sha256=").strip()
    return hmac.compare_digest(expected, supplied)


def geocode(query: str, limit: int = 5) -> list[dict[str, Any]]:
    if settings.maps_geocode_url:
        params = {"q": query, "limit": limit}
        if settings.maps_api_key:
            params["key"] = settings.maps_api_key
        try:
            r = http_get(settings.maps_geocode_url, params=params, timeout=8)
            if r.ok:
                payload = r.json()
                rows = payload.get("results") if isinstance(payload, dict) else payload
                if isinstance(rows, list):
                    out = []
                    for row in rows[:limit]:
                        lat = row.get("lat") or row.get("latitude")
                        lng = row.get("lng") or row.get("lon") or row.get("longitude")
                        if lat is None or lng is None:
                            continue
                        out.append({"label": row.get("label") or row.get("display_name") or row.get("name") or query, "lat": float(lat), "lng": float(lng), "source": settings.maps_provider})
                    return out
        except Exception:
            log.exception("geocode provider failed")
    return []


def route_estimate(origin_lat: float, origin_lng: float, destination_lat: float, destination_lng: float) -> dict[str, Any]:
    if settings.maps_directions_url:
        payload = {"origin": {"lat": origin_lat, "lng": origin_lng}, "destination": {"lat": destination_lat, "lng": destination_lng}}
        headers = {"Content-Type": "application/json"}
        if settings.maps_api_key:
            headers["Authorization"] = f"Bearer {settings.maps_api_key}"
        try:
            r = http_post(settings.maps_directions_url, headers=headers, json=payload, timeout=10)
            if r.ok:
                data = r.json()
                distance = data.get("distance_km") or data.get("distance")
                duration = data.get("duration_min") or data.get("duration_minutes") or data.get("duration")
                if distance is not None and duration is not None:
                    return {"distance_km": round(float(distance), 2), "duration_min": max(1, int(round(float(duration)))), "source": settings.maps_provider, "traffic": bool(data.get("traffic"))}
        except Exception:
            log.exception("directions provider failed")
    distance = haversine_km(origin_lat, origin_lng, destination_lat, destination_lng)
    # Conservative urban fallback for Tala pilot: 22km/h + 4min pickup/turn cost.
    duration = max(4, int(round(distance / 22.0 * 60 + 4)))
    return {"distance_km": round(distance, 2), "duration_min": duration, "source": "haversine-fallback", "traffic": False}


def setup_optional_otel(app) -> bool:
    if not settings.otel_endpoint:
        return False
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        provider = TracerProvider(resource=Resource.create({"service.name": settings.otel_service_name, "service.version": settings.app_version}))
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=settings.otel_endpoint.rstrip("/") + "/v1/traces")))
        trace.set_tracer_provider(provider)
        FastAPIInstrumentor.instrument_app(app)
        return True
    except Exception:
        log.exception("OTel requested but could not be initialized")
        return False
