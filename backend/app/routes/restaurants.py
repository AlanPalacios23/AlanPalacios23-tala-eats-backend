from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas
from ..db import get_read_db
from ..cache import catalog_version, get_json, set_json

router = APIRouter(prefix="/api/v1/restaurants", tags=["restaurants"])


@router.get("", response_model=list[schemas.RestaurantPublic])
def list_restaurants(
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=1_000_000),
    db: Session = Depends(get_read_db),
):
    key = f"catalog:v{catalog_version()}:restaurants:{offset}:{limit}"
    cached = get_json(key)
    if cached is not None:
        return cached
    rows = db.scalars(
        select(models.Restaurant)
        .order_by(models.Restaurant.is_open.desc(), models.Restaurant.name, models.Restaurant.id)
        .offset(offset)
        .limit(limit)
    ).all()
    payload = [schemas.RestaurantPublic.model_validate(row).model_dump(mode="json") for row in rows]
    set_json(key, payload, ttl=20)
    return payload


@router.get("/{restaurant_id}", response_model=schemas.RestaurantDetail)
def restaurant_detail(restaurant_id: int, db: Session = Depends(get_read_db)):
    stmt = (
        select(models.Restaurant)
        .where(models.Restaurant.id == restaurant_id)
        .options(selectinload(models.Restaurant.menu_items))
    )
    key = f"catalog:v{catalog_version()}:restaurant:{restaurant_id}"
    cached = get_json(key)
    if cached is not None:
        return cached
    restaurant = db.scalar(stmt)
    if not restaurant:
        raise HTTPException(status_code=404, detail="Restaurante no encontrado")
    restaurant.menu_items.sort(key=lambda item: (item.category, item.name))
    payload = schemas.RestaurantDetail.model_validate(restaurant).model_dump(mode="json")
    set_json(key, payload, ttl=20)
    return payload
