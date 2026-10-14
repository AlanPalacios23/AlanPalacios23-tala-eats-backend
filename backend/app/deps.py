from fastapi import Depends, HTTPException, Request, status
import hashlib
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .config import settings
from .db import get_db
from .security import decode_access_token, verify_device_attestation
from .request_context import device_session_id_var

bearer = HTTPBearer(auto_error=False)


def user_from_access_token(db: Session, token: str) -> models.User:
    """Resolve an access token and enforce server-side session revocation.

    This helper is shared by HTTP and WebSocket authentication so logout/password
    reset semantics are identical on every transport.
    """
    try:
        payload = decode_access_token(token)
        user_id = int(payload["sub"])
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesión inválida o vencida") from exc

    session_hash = hashlib.sha256(token.encode()).hexdigest()
    row = db.execute(
        select(models.User, models.DeviceSession.active, models.DeviceSession.id)
        .outerjoin(
            models.DeviceSession,
            (models.DeviceSession.session_hash == session_hash) & (models.DeviceSession.user_id == models.User.id),
        )
        .where(models.User.id == user_id)
        .limit(1)
    ).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuario no disponible")
    user, device_active, device_session_id = row
    device_session_id_var.set(device_session_id)
    db.info["device_session_id"] = device_session_id
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuario no disponible")
    if device_active is False:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Esta sesión fue cerrada desde Seguridad")
    # Hardened tokens carry a jti and must map to a persisted device session.
    # Legacy pre-hardening tokens without jti remain temporarily compatible until expiry.
    if payload.get("jti") and device_active is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesión no reconocida")
    return user


def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> models.User:
    token = credentials.credentials if credentials else request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesión requerida")
    user = user_from_access_token(db, token)
    # Optional signed installation attestation for newer mobile clients. Legacy
    # clients remain compatible; once X-Device-Token is supplied, it must bind
    # exactly to this user and X-Device-ID.
    device_token = request.headers.get("x-device-token", "").strip()
    if device_token:
        raw_device_id = request.headers.get("x-device-id", "").strip()[:256]
        if not verify_device_attestation(device_token, user.id, raw_device_id):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identidad de dispositivo inválida")
    return user


def require_role(*roles: str):
    def dependency(user: models.User = Depends(get_current_user)) -> models.User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No tienes permisos para esta acción")
        if settings.require_privileged_2fa and user.role in {"admin", "restaurant"} and not user.two_factor_enabled:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="V11 requiere 2FA para cuentas administrativas y de restaurante. Configúralo en Seguridad.")
        return user
    return dependency
