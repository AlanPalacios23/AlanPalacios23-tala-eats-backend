from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, case
from sqlalchemy.orm import Session, selectinload
from .. import models, schemas
from ..db import get_db
from ..deps import require_role
from ..realtime import publish_order_event
from ..geo import haversine_km
from ..config import settings
from .orders import VALID_STATUSES, order_options
from ..delivery_lifecycle import finalize_delivery
from ..finance_core_v2 import driver_cash_eligible
from ..cache import bump_catalog_version

router=APIRouter(prefix="/api/v1/owner",tags=["restaurant-owner"])
RESTAURANT_ALLOWED_STATUSES={"confirmed","preparing","ready","cancelled"}

def _restaurant_for_owner(db,user,restaurant_id=None):
    stmt=select(models.Restaurant).where(models.Restaurant.owner_id==user.id)
    if restaurant_id is not None: stmt=stmt.where(models.Restaurant.id==restaurant_id)
    row=db.scalar(stmt)
    if not row: raise HTTPException(404,"No tienes un restaurante asignado")
    return row


def _assign_best_available_driver(db: Session, order: models.Order):
    """Atomically assign the closest available verified driver.

    Candidate profiles are scored without locks, then the selected profile row is
    locked with SKIP LOCKED and revalidated. This keeps dispatch concurrent while
    preventing the same driver from receiving two active orders.
    """
    profiles = db.scalars(
        select(models.DriverProfile)
        .join(models.User, models.User.id == models.DriverProfile.user_id)
        .where(
            models.User.role == "driver",
            models.User.is_active.is_(True),
            models.DriverProfile.is_online.is_(True),
            models.DriverProfile.is_verified.is_(True),
        )
    ).all()
    if not profiles:
        return None

    restaurant = order.restaurant or db.get(models.Restaurant, order.restaurant_id)

    def score(profile):
        if restaurant and profile.current_lat is not None and profile.current_lng is not None:
            distance = haversine_km(profile.current_lat, profile.current_lng, restaurant.lat, restaurant.lng)
        else:
            distance = 9999.0
        return (distance, profile.total_deliveries, profile.user_id)

    for candidate in sorted(profiles, key=score):
        locked = db.scalar(
            select(models.DriverProfile)
            .where(
                models.DriverProfile.id == candidate.id,
                models.DriverProfile.is_online.is_(True),
                models.DriverProfile.is_verified.is_(True),
            )
            .with_for_update(skip_locked=True)
        )
        if not locked:
            continue
        active = db.scalar(
            select(models.Order.id)
            .where(
                models.Order.driver_id == locked.user_id,
                models.Order.status.in_(["assigned", "picked_up", "on_the_way"]),
            )
            .limit(1)
        )
        if active:
            continue
        if settings.finance_v2_shadow_enabled and not driver_cash_eligible(db, locked.user_id, order):
            continue
        order.driver_id = locked.user_id
        order.status = "assigned"
        db.add(models.OrderEvent(order_id=order.id, status="assigned", actor_user_id=locked.user_id, metadata_json='{"source":"auto_assignment"}'))
        db.add(models.Notification(user_id=locked.user_id, kind="delivery", title="Nueva entrega asignada", message=f"Pedido #{order.id} listo para recoger."))
        return locked.user_id
    return None


def user_id_or_none(user):
    return getattr(user, "id", None)

@router.get("/restaurant",response_model=schemas.RestaurantDetail)
def my_restaurant(user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    r=_restaurant_for_owner(db,user); db.refresh(r,attribute_names=["menu_items"]); return r

@router.get("/orders",response_model=list[schemas.OrderOperationalPublic])
def orders(
    active_only: bool = False,
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=1_000_000),
    user: models.User = Depends(require_role("restaurant","admin")),
    db: Session = Depends(get_db),
):
    ids=db.scalars(select(models.Restaurant.id).where(models.Restaurant.owner_id==user.id)).all()
    if user.role=="admin" and not ids: ids=db.scalars(select(models.Restaurant.id)).all()
    if not ids:return []
    stmt=select(models.Order).where(models.Order.restaurant_id.in_(ids))
    if active_only:
        stmt=stmt.where(models.Order.status.notin_(["delivered","cancelled"]))
    stmt=stmt.options(*order_options()).order_by(models.Order.created_at.desc()).offset(offset).limit(limit)
    return db.scalars(stmt).all()

@router.get("/kds",response_model=dict)
def kds(user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    lanes_status=["received","confirmed","preparing","ready"] + (["on_the_way"] if settings.merchant_managed_delivery else ["assigned","picked_up","on_the_way"])
    r=_restaurant_for_owner(db,user); rows=db.scalars(select(models.Order).where(models.Order.restaurant_id==r.id,models.Order.status.in_(lanes_status),((models.Order.payment_method=="cash") | (models.Order.payment_status=="paid"))).options(*order_options()).order_by(models.Order.created_at).limit(500)).all()
    horizon=datetime.now(timezone.utc)+timedelta(minutes=settings.schedule_prep_lead_minutes)
    rows=[o for o in rows if o.scheduled_for is None or o.scheduled_for <= horizon]
    lanes={s:[] for s in lanes_status}
    for o in rows: lanes[o.status].append(schemas.OrderOperationalPublic.model_validate(o).model_dump(mode="json"))
    return lanes

@router.patch("/orders/{order_id}/status",response_model=schemas.OrderOperationalPublic)
def update_status(order_id:int,payload:schemas.OrderStatusUpdate,user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    if payload.status not in VALID_STATUSES: raise HTTPException(400,"Estado inválido")
    allowed=set(RESTAURANT_ALLOWED_STATUSES)
    if settings.merchant_managed_delivery: allowed.add("on_the_way")
    if user.role!="admin" and payload.status not in allowed: raise HTTPException(400,"Ese estado no está disponible para el comercio")
    order=db.scalar(
        select(models.Order)
        .where(models.Order.id==order_id)
        .with_for_update()
        .options(*order_options(),selectinload(models.Order.restaurant))
    )
    if not order:raise HTTPException(404,"Pedido no encontrado")
    if user.role!="admin" and order.restaurant.owner_id!=user.id:raise HTTPException(403,"Ese pedido no pertenece a tu restaurante")
    if order.payment_method in {"mercadopago", "stripe"} and order.payment_status != "paid" and payload.status != "cancelled":
        raise HTTPException(409,"El proveedor de pagos aún no confirmó el cobro de este pedido")
    if payload.status == "cancelled" and order.payment_method in {"mercadopago", "stripe"} and order.payment_status == "paid":
        raise HTTPException(409,"El pedido ya está pagado. Cancélalo desde ADMIN usando el flujo de reembolso para conservar la conciliación")
    if user.role != "admin":
        next_status = {
            "received": {"confirmed", "cancelled"},
            "confirmed": {"preparing", "cancelled"},
            "preparing": {"ready", "cancelled"},
            "ready": {"on_the_way"} if order.order_type == "delivery" and settings.merchant_managed_delivery else set(),
            "on_the_way": set(),
        }
        if payload.status not in next_status.get(order.status, set()):
            raise HTTPException(409, f"Transición inválida: {order.status} → {payload.status}")
        if payload.status == "on_the_way" and order.order_type != "delivery":
            raise HTTPException(409,"Los pedidos para recoger no pasan al estado en camino")
    order.status=payload.status
    stamp=datetime.now(timezone.utc)
    if payload.status=="confirmed": order.accepted_at=stamp
    elif payload.status=="preparing": order.preparing_at=stamp
    elif payload.status=="ready": order.ready_at=stamp
    elif payload.status=="on_the_way": order.picked_up_at=order.picked_up_at or stamp
    db.add(models.OrderEvent(order_id=order.id,status=payload.status,actor_user_id=user.id,metadata_json='{"source":"restaurant"}'))
    if (not settings.merchant_managed_delivery) and payload.status=="ready" and order.order_type=="delivery" and order.driver_id is None:
        _assign_best_available_driver(db, order)
    db.add(models.Notification(user_id=order.user_id,kind="order",title="Actualización de pedido",message=f"Tu pedido #{order.id} cambió a {order.status}."))
    db.commit(); publish_order_event(order.id,"order.status",{"status":order.status,"driver_id":order.driver_id}); return db.scalar(select(models.Order).where(models.Order.id==order_id).options(*order_options()))


@router.post("/orders/{order_id}/complete",response_model=schemas.OrderOperationalPublic)
def complete_delivery(order_id:int,payload:schemas.DeliveryCompleteRequest,user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    if not settings.merchant_managed_delivery and user.role != "admin":
        raise HTTPException(400,"La entrega administrada por comercio no está activa")
    order=db.scalar(select(models.Order).where(models.Order.id==order_id).with_for_update().options(*order_options(),selectinload(models.Order.restaurant)))
    if not order: raise HTTPException(404,"Pedido no encontrado")
    if user.role!="admin" and order.restaurant.owner_id!=user.id: raise HTTPException(403,"Ese pedido no pertenece a tu restaurante")
    if order.payment_method in {"mercadopago", "stripe"} and order.payment_status != "paid": raise HTTPException(409,"El proveedor de pagos aún no confirmó el cobro")
    if order.order_type == "delivery" and order.status != "on_the_way": raise HTTPException(409,"Primero marca el pedido como en camino")
    if order.order_type == "pickup" and order.status != "ready": raise HTTPException(409,"El pedido para recoger debe estar listo antes de entregarse")
    if payload.pin!=order.delivery_pin: raise HTTPException(400,"PIN incorrecto")
    finalize_delivery(db,order,user.id,"merchant_delivery_pin",payload.photo_url,payload.lat,payload.lng,False)
    return db.scalar(select(models.Order).where(models.Order.id==order.id).options(*order_options()))

@router.post("/menu",response_model=schemas.MenuItemPublic,status_code=201)
def add_menu(payload:schemas.MenuItemCreate,user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    r=_restaurant_for_owner(db,user); row=models.MenuItem(restaurant_id=r.id,**payload.model_dump()); db.add(row);db.commit();db.refresh(row);return row

@router.patch("/menu/{item_id}",response_model=schemas.MenuItemPublic)
def update_menu(item_id:int,payload:schemas.MenuItemUpdate,user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    item=db.get(models.MenuItem,item_id)
    if not item:raise HTTPException(404,"Producto no encontrado")
    r=db.get(models.Restaurant,item.restaurant_id)
    if user.role!="admin" and r.owner_id!=user.id:raise HTTPException(403,"No puedes modificar ese producto")
    for k,v in payload.model_dump(exclude_unset=True).items():setattr(item,k,v)
    db.commit();db.refresh(item);return item

@router.delete("/menu/{item_id}",status_code=204)
def delete_menu(item_id:int,user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    item=db.get(models.MenuItem,item_id)
    if not item:raise HTTPException(404,"Producto no encontrado")
    r=db.get(models.Restaurant,item.restaurant_id)
    if user.role!="admin" and r.owner_id!=user.id:raise HTTPException(403,"No puedes eliminar ese producto")
    db.delete(item);db.commit()

@router.patch("/restaurant",response_model=schemas.RestaurantPublic)
def update_restaurant(payload:schemas.RestaurantUpdate,user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    r=_restaurant_for_owner(db,user)
    for k,v in payload.model_dump(exclude_unset=True).items():setattr(r,k,v)
    db.commit()
    bump_catalog_version()  # Refresh customer-visible location and profile caches.
    db.refresh(r);return r

@router.get("/analytics")
def analytics(user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    r=_restaurant_for_owner(db,user)
    total_orders, delivered_count, gross = db.execute(
        select(
            func.count(models.Order.id),
            func.coalesce(func.sum(case((models.Order.status == "delivered", 1), else_=0)), 0),
            func.coalesce(func.sum(case((models.Order.status == "delivered", models.Order.total), else_=0)), 0),
        ).where(models.Order.restaurant_id == r.id)
    ).one()
    delivered_count=int(delivered_count or 0)
    gross=float(gross or 0)
    inventory_low=db.scalar(
        select(func.count(models.MenuItem.id)).where(
            models.MenuItem.restaurant_id==r.id,
            models.MenuItem.stock<10,
        )
    ) or 0
    return {
        "orders": int(total_orders or 0),
        "delivered": delivered_count,
        "gross_sales": gross,
        "avg_ticket": (gross / delivered_count) if delivered_count else 0,
        "inventory_low": int(inventory_low),
    }

@router.get("/employees")
def employees(user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    r=_restaurant_for_owner(db,user)
    rows=db.scalars(select(models.RestaurantEmployee).where(models.RestaurantEmployee.restaurant_id==r.id)).all()
    users = {}
    if rows:
        users = {u.id: u for u in db.scalars(select(models.User).where(models.User.id.in_([row.user_id for row in rows]))).all()}
    return [
        {"id":row.id,"user_id":row.user_id,"name":users[row.user_id].name if row.user_id in users else "Usuario","email":users[row.user_id].email if row.user_id in users else "","role":row.role}
        for row in rows
    ]

@router.post("/employees")
def add_employee(email:str,role:str="cashier",user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    if role not in {"manager","cashier","kitchen"}: raise HTTPException(400,"Rol inválido")
    r=_restaurant_for_owner(db,user);employee=db.scalar(select(models.User).where(models.User.email==email.lower().strip()))
    if not employee: raise HTTPException(404,"Primero crea la cuenta del empleado")
    exists=db.scalar(select(models.RestaurantEmployee).where(models.RestaurantEmployee.restaurant_id==r.id,models.RestaurantEmployee.user_id==employee.id))
    if exists: exists.role=role;row=exists
    else: row=models.RestaurantEmployee(restaurant_id=r.id,user_id=employee.id,role=role);db.add(row)
    db.commit();return {"id":row.id,"user_id":employee.id,"name":employee.name,"email":employee.email,"role":row.role}
