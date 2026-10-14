import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models
from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_role

router = APIRouter(prefix="/api/v1/uploads", tags=["uploads"])
ALLOWED = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
ONBOARDING_ALLOWED = {**ALLOWED, "application/pdf": ".pdf"}
MIME_BY_SUFFIX = {value: key for key, value in ONBOARDING_ALLOWED.items()}


def _matches_magic(content_type: str, data: bytes) -> bool:
    if content_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if content_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    if content_type == "application/pdf":
        return data.startswith(b"%PDF-")
    return False


def _safe_name(filename: str) -> str:
    safe = Path(filename).name
    if safe != filename:
        raise HTTPException(400, "Nombre de archivo inválido")
    return safe


def _proof_path(filename: str) -> Path:
    return settings.media_dir / "delivery-proofs" / _safe_name(filename)


def _onboarding_path(filename: str) -> Path:
    return settings.media_dir / "onboarding" / _safe_name(filename)


@router.post("/delivery-proof")
async def delivery_proof(file: UploadFile = File(...), _: models.User = Depends(require_role("driver", "admin"))):
    ext = ALLOWED.get(file.content_type or "")
    if not ext:
        raise HTTPException(415, "Formato no permitido. Usa JPG, PNG o WEBP")
    data = await file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"La imagen supera {settings.max_upload_mb} MB")
    if not _matches_magic(file.content_type or "", data):
        raise HTTPException(415, "El contenido real del archivo no coincide con su formato")
    directory = settings.media_dir / "delivery-proofs"
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{secrets.token_urlsafe(24)}{ext}"
    await run_in_threadpool(_proof_path(filename).write_bytes, data)
    # The URL is authenticated; delivery evidence is not exposed as a public static directory.
    return {"url": f"/api/v1/uploads/delivery-proof/{filename}"}


@router.get("/delivery-proof/{filename}")
def get_delivery_proof(filename: str, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    path = _proof_path(filename)
    if not path.is_file():
        raise HTTPException(404, "Evidencia no encontrada")
    url = f"/api/v1/uploads/delivery-proof/{filename}"
    proof = db.scalar(select(models.DeliveryProof).where(models.DeliveryProof.photo_url == url))
    if user.role != "admin":
        if not proof:
            raise HTTPException(403, "Evidencia aún no asociada a una entrega")
        order = db.get(models.Order, proof.order_id)
        restaurant = db.get(models.Restaurant, order.restaurant_id) if order else None
        allowed = bool(order and (user.id in {order.user_id, order.driver_id} or (user.role == "restaurant" and restaurant and restaurant.owner_id == user.id)))
        if not allowed:
            raise HTTPException(403, "Sin acceso a esta evidencia")
    media_type = MIME_BY_SUFFIX.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, no-store"})


@router.post("/onboarding-document")
async def onboarding_document(file: UploadFile = File(...), user: models.User = Depends(get_current_user)):
    ext = ONBOARDING_ALLOWED.get(file.content_type or "")
    if not ext:
        raise HTTPException(415, "Formato no permitido. Usa PDF, JPG, PNG o WEBP")
    data = await file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"El archivo supera {settings.max_upload_mb} MB")
    if not _matches_magic(file.content_type or "", data):
        raise HTTPException(415, "El contenido real del archivo no coincide con su formato")
    directory = settings.media_dir / "onboarding"
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"u{user.id}-{secrets.token_urlsafe(24)}{ext}"
    await run_in_threadpool(_onboarding_path(filename).write_bytes, data)
    return {"url": f"/api/v1/uploads/onboarding-document/{filename}", "name": file.filename or filename}


@router.get("/onboarding-document/{filename}")
def get_onboarding_document(filename: str, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    path = _onboarding_path(filename)
    if not path.is_file():
        raise HTTPException(404, "Documento no encontrado")
    url = f"/api/v1/uploads/onboarding-document/{filename}"
    if user.role != "admin":
        rows = db.scalars(select(models.OnboardingApplication).where(models.OnboardingApplication.user_id == user.id)).all()
        allowed = any(url in (row.documents_json or "") for row in rows)
        if not allowed:
            raise HTTPException(403, "Sin acceso a este documento")
    media_type = MIME_BY_SUFFIX.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, no-store"})



def _catalog_path(filename: str) -> Path:
    return settings.media_dir / "catalog" / _safe_name(filename)


def _catalog_public_url(filename: str) -> str:
    return f"{settings.public_base_url}/api/v1/uploads/catalog/{filename}"


def _owned_restaurant(db: Session, user: models.User) -> models.Restaurant:
    if user.role == "admin":
        raise HTTPException(400, "El administrador debe usar una cuenta de restaurante para subir media de catálogo")
    row = db.scalar(select(models.Restaurant).where(models.Restaurant.owner_id == user.id))
    if not row:
        raise HTTPException(404, "Restaurante no encontrado")
    return row


async def _store_catalog_image(file: UploadFile, prefix: str) -> tuple[str, Path]:
    ext = ALLOWED.get(file.content_type or "")
    if not ext:
        raise HTTPException(415, "Formato no permitido. Usa JPG, PNG o WEBP")
    data = await file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"La imagen supera {settings.max_upload_mb} MB")
    if not _matches_magic(file.content_type or "", data):
        raise HTTPException(415, "El contenido real del archivo no coincide con su formato")
    directory = settings.media_dir / "catalog"
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{prefix}-{secrets.token_urlsafe(24)}{ext}"
    path = _catalog_path(filename)
    await run_in_threadpool(path.write_bytes, data)
    return _catalog_public_url(filename), path


def _remove_old_catalog_file(url: str) -> None:
    prefix = f"{settings.public_base_url}/api/v1/uploads/catalog/"
    if not url.startswith(prefix):
        return
    filename = url[len(prefix):]
    try:
        path = _catalog_path(filename)
    except HTTPException:
        return
    try:
        if path.is_file():
            path.unlink()
    except OSError:
        pass


@router.post("/catalog/restaurant-cover")
async def upload_restaurant_cover(
    file: UploadFile = File(...),
    user: models.User = Depends(require_role("restaurant")),
    db: Session = Depends(get_db),
):
    restaurant = _owned_restaurant(db, user)
    old_url = restaurant.cover_image_url or ""
    url, _ = await _store_catalog_image(file, f"r{restaurant.id}")
    restaurant.cover_image_url = url
    db.commit(); db.refresh(restaurant)
    _remove_old_catalog_file(old_url)
    return {"url": url, "restaurant_id": restaurant.id}


@router.post("/catalog/menu/{item_id}")
async def upload_menu_item_image(
    item_id: int,
    file: UploadFile = File(...),
    user: models.User = Depends(require_role("restaurant")),
    db: Session = Depends(get_db),
):
    restaurant = _owned_restaurant(db, user)
    item = db.get(models.MenuItem, item_id)
    if not item or item.restaurant_id != restaurant.id:
        raise HTTPException(404, "Producto no encontrado")
    old_url = item.image_url or ""
    url, _ = await _store_catalog_image(file, f"r{restaurant.id}-p{item.id}")
    item.image_url = url
    db.commit(); db.refresh(item)
    _remove_old_catalog_file(old_url)
    return {"url": url, "item_id": item.id}


@router.get("/catalog/{filename}")
def get_catalog_image(filename: str):
    path = _catalog_path(filename)
    if not path.is_file():
        raise HTTPException(404, "Imagen no encontrada")
    media_type = MIME_BY_SUFFIX.get(path.suffix.lower(), "application/octet-stream")
    if media_type not in ALLOWED:
        raise HTTPException(404, "Imagen no encontrada")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=31536000, immutable"})

def _chat_media_path(filename: str) -> Path:
    return settings.media_dir / "chat-media" / _safe_name(filename)


def _order_access(db: Session, user: models.User, order_id: int) -> bool:
    order = db.get(models.Order, order_id)
    if not order:
        return False
    if user.role == "admin" or user.id in {order.user_id, order.driver_id}:
        return True
    rest = db.get(models.Restaurant, order.restaurant_id)
    return bool(user.role == "restaurant" and rest and rest.owner_id == user.id)


@router.post("/chat-media/{order_id}")
async def chat_media(order_id: int, file: UploadFile = File(...), user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not _order_access(db, user, order_id):
        raise HTTPException(403, "Sin acceso a ese pedido")
    ext = ALLOWED.get(file.content_type or "")
    if not ext:
        raise HTTPException(415, "Formato no permitido. Usa JPG, PNG o WEBP")
    data = await file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"La imagen supera {settings.max_upload_mb} MB")
    if not _matches_magic(file.content_type or "", data):
        raise HTTPException(415, "El contenido real del archivo no coincide con su formato")
    directory = settings.media_dir / "chat-media"; directory.mkdir(parents=True, exist_ok=True)
    filename = f"o{order_id}-u{user.id}-{secrets.token_urlsafe(20)}{ext}"
    await run_in_threadpool(_chat_media_path(filename).write_bytes, data)
    return {"url": f"/api/v1/uploads/chat-media/{filename}"}


@router.get("/chat-media/{filename}")
def get_chat_media(filename: str, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    path = _chat_media_path(filename)
    if not path.is_file():
        raise HTTPException(404, "Archivo no encontrado")
    url = f"/api/v1/uploads/chat-media/{filename}"
    message = db.scalar(select(models.ChatMessage).where(models.ChatMessage.media_url == url))
    if not message or not _order_access(db, user, message.order_id):
        raise HTTPException(403, "Sin acceso")
    media_type = MIME_BY_SUFFIX.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, no-store"})
