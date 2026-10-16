from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas
from ..db import get_read_db
from ..cache import catalog_version, get_json, set_json

router = APIRouter(prefix="/api/v1/restaurants", tags=["restaurants"])


@router.get("", response_model=list[schemas.RestaurantPublic])
def list_restaurants(
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=1_000_000),
    market_code: str | None = Query(default=None, min_length=3, max_length=40, pattern=r"^[a-zA-Z][a-zA-Z0-9-]*$"),
    cuisine: str | None = Query(default=None, min_length=1, max_length=100),
    pickup_only: bool = Query(default=False),
    db: Session = Depends(get_read_db),
):
    # The client resolves GPS to a configured local-market code, then queries
    # this endpoint. Filtering is server-side, BEFORE pagination, so other
    # cities cannot leak into the selected city's pages.
    market = market_code.upper() if market_code else None
    category = cuisine.strip().lower() if cuisine else None
    key = f"catalog:v{catalog_version()}:restaurants:{market or 'all'}:{category or 'all'}:{int(pickup_only)}:{offset}:{limit}"
    cached = get_json(key)
    if cached is not None:
        return cached
    stmt = select(models.Restaurant)
    if market is not None:
        stmt = stmt.where(models.Restaurant.market_code == market)
    if category is not None:
        stmt = stmt.where(func.lower(models.Restaurant.cuisine) == category)
    if pickup_only:
        stmt = stmt.where(models.Restaurant.pickup_enabled.is_(True))
    rows = db.scalars(
        stmt.order_by(models.Restaurant.is_open.desc(), models.Restaurant.name, models.Restaurant.id)
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
