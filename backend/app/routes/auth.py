from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from datetime import datetime, timedelta, timezone
import hashlib
import secrets
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import settings
from ..db import get_db
from ..deps import get_current_user
from ..security import create_access_token, create_device_attestation, hash_password, verify_password, verify_totp
from ..wallet import get_loyalty_account
from ..email_service import enqueue_email

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def _set_session(response: Response, user: models.User, request: Request | None = None, db: Session | None = None):
    token = create_access_token(user.id, user.role)
    raw_device_id = request.headers.get("x-device-id", "").strip()[:256] if request else ""
    device_id_hash = hashlib.sha256(raw_device_id.encode()).hexdigest() if raw_device_id else ""
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.access_token_minutes * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    if db is not None and request is not None:
        session_hash = hashlib.sha256(token.encode()).hexdigest()
        existing = db.scalar(select(models.DeviceSession).where(models.DeviceSession.session_hash == session_hash))
        if not existing:
            platform = request.headers.get("x-talaeats-client", "unknown").strip().lower()[:40] or "unknown"
            risk_score = 0
            if device_id_hash:
                other_users = db.scalar(
                    select(models.DeviceSession.user_id)
                    .where(models.DeviceSession.device_id_hash == device_id_hash, models.DeviceSession.user_id != user.id)
                    .limit(1)
                )
                if other_users:
                    risk_score = 40
                    db.add(models.FraudFlag(user_id=user.id, reason="Dispositivo observado en más de una cuenta", severity="medium", risk_score=40, signal="shared_device"))
            db.add(models.DeviceSession(
                user_id=user.id, session_hash=session_hash, device_id_hash=device_id_hash,
                device_label=(request.headers.get("user-agent") or "Dispositivo")[:200],
                platform=platform, ip_hint=(request.client.host if request.client else "")[:80], risk_score=risk_score,
            ))
            db.commit()
    client_kind = request.headers.get("x-talaeats-client", "").strip().lower() if request else ""
    mobile_client = client_kind in {"mobile", "customer-mobile", "restaurant-mobile", "driver-mobile"}
    device_token = create_device_attestation(user.id, device_id_hash) if raw_device_id else ""
    return schemas.AuthResponse(
        access_token=token if mobile_client or not settings.is_production else "cookie",
        user=user, device_token=device_token,
    )


@router.post("/register", response_model=schemas.AuthResponse, status_code=201)
def register(payload: schemas.RegisterRequest, response: Response, request: Request, db: Session = Depends(get_db)):
    email = payload.email.lower().strip()
    if db.scalar(select(models.User).where(models.User.email == email)):
        raise HTTPException(status_code=409, detail="Ese correo ya está registrado")
    user = models.User(name=payload.name.strip(), email=email, password_hash=hash_password(payload.password), role="customer", auth_provider="local")
    db.add(user); db.flush()
    get_loyalty_account(db, user.id)
    db.add(models.Notification(user_id=user.id, kind="account", title="Bienvenido a Tala Eats", message="Tu cuenta y Tala Wallet están listas para usarse."))
    enqueue_email(db, user.email, "Bienvenido a Tala Eats", f"Hola {user.name},\n\nTu cuenta de Tala Eats ya está activa. Ya puedes descubrir restaurantes, pedir y seguir tus entregas desde {settings.frontend_url}.\n\nEquipo Tala Eats")
    db.commit(); db.refresh(user)
    return _set_session(response, user, request, db)


@router.post("/login", response_model=schemas.AuthResponse)
def login(payload: schemas.LoginRequest, response: Response, request: Request, db: Session = Depends(get_db)):
    user = db.scalar(select(models.User).where(models.User.email == payload.email.lower().strip()))
    if not user or not user.password_hash or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Correo o contraseña incorrectos")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="La cuenta está desactivada")
    if user.two_factor_enabled and not verify_totp(user.totp_secret, payload.otp):
        raise HTTPException(status_code=401, detail="Código de verificación 2FA requerido o inválido")
    return _set_session(response, user, request, db)


@router.post("/logout", status_code=204)
def logout(response: Response, request: Request, db: Session = Depends(get_db)):
    authorization = request.headers.get("authorization", "")
    bearer_token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    token = bearer_token or request.cookies.get(settings.session_cookie_name)
    if token:
        session_hash = hashlib.sha256(token.encode()).hexdigest()
        row = db.scalar(select(models.DeviceSession).where(models.DeviceSession.session_hash == session_hash))
        if row:
            row.active = False; db.commit()
    response.delete_cookie(settings.session_cookie_name, path="/", secure=settings.cookie_secure, httponly=True, samesite="lax")


@router.get("/devices")
def list_devices(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    current_id = db.info.get("device_session_id")
    rows = db.scalars(
        select(models.DeviceSession)
        .where(models.DeviceSession.user_id == user.id)
        .order_by(models.DeviceSession.created_at.desc())
        .limit(100)
    ).all()
    return [{
        "id": row.id,
        "device_label": row.device_label,
        "platform": row.platform,
        "risk_score": row.risk_score,
        "trusted": row.trusted,
        "active": row.active,
        "current": row.id == current_id,
        "created_at": row.created_at,
        "last_seen_at": row.last_seen_at,
    } for row in rows]


@router.post("/devices/{device_id}/revoke")
def revoke_device(device_id: int, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.scalar(
        select(models.DeviceSession)
        .where(models.DeviceSession.id == device_id, models.DeviceSession.user_id == user.id)
        .with_for_update()
    )
    if not row:
        raise HTTPException(404, "Dispositivo no encontrado")
    before = f'{{"active":{str(bool(row.active)).lower()},"trusted":{str(bool(row.trusted)).lower()}}}'
    row.active = False
    row.trusted = False
    db.add(models.AuditEvent(
        user_id=user.id, action="device.revoke", entity_type="device_session", entity_id=str(row.id),
        before_json=before, after_json='{"active":false,"trusted":false}'
    ))
    current = row.id == db.info.get("device_session_id")
    db.commit()
    return {"revoked": True, "device_id": row.id, "current": current}


@router.post("/devices/revoke-others")
def revoke_other_devices(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    current_id = db.info.get("device_session_id")
    rows = db.scalars(
        select(models.DeviceSession)
        .where(models.DeviceSession.user_id == user.id, models.DeviceSession.active.is_(True))
        .with_for_update()
    ).all()
    revoked = 0
    for row in rows:
        if row.id == current_id:
            continue
        row.active = False
        row.trusted = False
        revoked += 1
    db.add(models.AuditEvent(user_id=user.id, action="device.revoke_others", entity_type="user", entity_id=str(user.id), detail=f"revoked={revoked}"))
    db.commit()
    return {"revoked": revoked, "current_device_id": current_id}


@router.patch("/me", response_model=schemas.UserPublic)
def update_me(payload: schemas.ProfileUpdate, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    values = payload.model_dump(exclude_unset=True)
    for key, value in values.items():
        if value is not None:
            setattr(user, key, value.strip() if isinstance(value, str) else value)
    db.add(models.AuditEvent(user_id=user.id, action="profile.update", entity_type="user", entity_id=str(user.id)))
    db.commit(); db.refresh(user)
    return user


@router.post("/password/forgot", status_code=202)
def forgot_password(payload: schemas.PasswordForgotRequest, db: Session = Depends(get_db)):
    # Always return the same response so this endpoint cannot be used to enumerate accounts.
    user = db.scalar(select(models.User).where(models.User.email == payload.email.lower().strip()))
    if user and user.password_hash and user.is_active:
        raw = secrets.token_urlsafe(40)
        token_hash = hashlib.sha256(raw.encode()).hexdigest()
        expires = datetime.now(timezone.utc) + timedelta(minutes=settings.password_reset_minutes)
        db.add(models.PasswordResetToken(user_id=user.id, token_hash=token_hash, expires_at=expires))
        reset_url = f"{settings.frontend_url}/restablecer?token={raw}"
        enqueue_email(db, user.email, "Restablece tu contraseña de Tala Eats", f"Hola {user.name},\n\nRecibimos una solicitud para cambiar tu contraseña. Abre este enlace antes de {settings.password_reset_minutes} minutos:\n\n{reset_url}\n\nSi no fuiste tú, ignora este mensaje.")
        db.add(models.AuditEvent(user_id=user.id, action="password.reset.request", entity_type="user", entity_id=str(user.id)))
        db.commit()
    return {"message": "Si el correo está registrado, enviaremos instrucciones para restablecer la contraseña."}


@router.post("/password/reset")
def reset_password(payload: schemas.PasswordResetConfirm, db: Session = Depends(get_db)):
    token_hash = hashlib.sha256(payload.token.encode()).hexdigest()
    now = datetime.now(timezone.utc)
    row = db.scalar(select(models.PasswordResetToken).where(models.PasswordResetToken.token_hash == token_hash).with_for_update())
    expires = row.expires_at if row else None
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if not row or row.used_at is not None or expires < now:
        raise HTTPException(400, "El enlace de recuperación es inválido o expiró")
    user = db.get(models.User, row.user_id)
    if not user or not user.is_active:
        raise HTTPException(400, "La cuenta ya no está disponible")
    user.password_hash = hash_password(payload.password)
    # Password reset is a security boundary: revoke every existing device session.
    for device in db.scalars(select(models.DeviceSession).where(models.DeviceSession.user_id == user.id, models.DeviceSession.active.is_(True))).all():
        device.active = False
    if user.auth_provider == "google":
        user.auth_provider = "local+google"
    row.used_at = now
    db.add(models.AuditEvent(user_id=user.id, action="password.reset.complete", entity_type="user", entity_id=str(user.id)))
    db.add(models.Notification(user_id=user.id, kind="security", title="Contraseña actualizada", message="Tu contraseña de Tala Eats fue cambiada correctamente."))
    db.commit()
    return {"message": "Contraseña actualizada. Ya puedes iniciar sesión."}


@router.get("/google/config")
def google_config():
    return {"enabled": bool(settings.google_client_id), "client_id": settings.google_client_id or None}


@router.post("/google", response_model=schemas.AuthResponse)
def google_login(payload: schemas.GoogleAuthRequest, response: Response, request: Request, db: Session = Depends(get_db)):
    if not settings.google_client_id:
        raise HTTPException(status_code=503, detail="Google Sign-In no está configurado")
    try:
        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token
        info = id_token.verify_oauth2_token(payload.credential, google_requests.Request(), settings.google_client_id)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="No se pudo validar la sesión de Google") from exc
    email = str(info.get("email", "")).lower().strip()
    if not email or not info.get("email_verified"):
        raise HTTPException(status_code=401, detail="Google no confirmó un correo válido")
    sub = str(info.get("sub") or "").strip()
    if not sub:
        raise HTTPException(401, "Google no confirmó un identificador válido")
    user = db.scalar(select(models.User).where(models.User.google_sub == sub)) or db.scalar(select(models.User).where(models.User.email == email))
    # Authentication is a security boundary: reject before mutating any
    # account, linking a Google identity or issuing device/session tokens.
    if user:
        if not user.is_active:
            raise HTTPException(403, "La cuenta está desactivada")
        if user.google_sub and user.google_sub != sub:
            raise HTTPException(409, "La cuenta ya está vinculada a otra identidad de Google")
        if user.two_factor_enabled and not verify_totp(user.totp_secret, payload.otp):
            raise HTTPException(401, "Código de verificación 2FA requerido o inválido")
    created = False
    if not user:
        user = models.User(name=str(info.get("name") or email.split("@")[0]), email=email, password_hash=None, role="customer", auth_provider="google", google_sub=sub, avatar_url=info.get("picture"))
        db.add(user); db.flush(); created = True
    else:
        user.google_sub = user.google_sub or sub
        user.avatar_url = info.get("picture") or user.avatar_url
        if user.auth_provider == "local": user.auth_provider = "local+google"
    get_loyalty_account(db, user.id)
    if created:
        db.add(models.Notification(user_id=user.id, kind="account", title="Bienvenido a Tala Eats", message="Tu cuenta de Google y Tala Wallet quedaron activadas."))
    db.commit(); db.refresh(user)
    return _set_session(response, user, request, db)


@router.get("/me", response_model=schemas.UserPublic)
def me(user: models.User = Depends(get_current_user)):
    return user
