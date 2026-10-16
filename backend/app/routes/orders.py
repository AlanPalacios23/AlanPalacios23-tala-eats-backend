from decimal import Decimal
from datetime import datetime, timezone
import hashlib
import hmac
import json

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas
from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_role
from ..geo import haversine_km
from ..realtime import publish_order_event
from ..inventory import restore_order_inventory
from ..wallet import credit_wallet, debit_wallet, get_loyalty_account
from ..monetization import calculate_order_economics, effective_delivery_fee, commercial_v152_active, commercial_v162_active, commercial_value, post_order_ledger
from ..outbox import enqueue_event
from ..fraud import flag_order_if_needed
from ..feature_flags import enabled as feature_enabled

router = APIRouter(prefix="/api/v1/orders", tags=["orders"])
VALID_STATUSES={"received","confirmed","preparing","ready","assigned","picked_up","on_the_way","delivered","cancelled"}


def order_options():
    return (
        selectinload(models.Order.items),
        selectinload(models.Order.driver).selectinload(models.User.driver_profile),
        selectinload(models.Order.restaurant),
        selectinload(models.Order.customer),
    )


def _load_order(db, order_id, *, lock: bool = False):
    stmt = select(models.Order).where(models.Order.id == order_id)
    if lock:
        stmt = stmt.with_for_update()
    return db.scalar(stmt.options(*order_options()))


def _coupon_discount(db,code,subtotal):
    if not code:
        return Decimal("0")
    coupon=db.scalar(select(models.Coupon).where(models.Coupon.code==code.upper().strip(),models.Coupon.active.is_(True)))
    if not coupon or subtotal < coupon.min_order:
        return Decimal("0")
    return min(subtotal, (subtotal*coupon.value/100 if coupon.discount_type=="percent" else coupon.value)).quantize(Decimal("0.01"))

def _effective_item(item, instant=None):
    instant=instant or datetime.now(timezone.utc); available=bool(item.is_available); price=Decimal(item.price)
    try:
        schedule=json.loads(item.availability_schedule_json or "{}"); windows=schedule.get("windows",[]) if isinstance(schedule,dict) else []
        if windows:
            available=False; weekday=instant.weekday(); clock=instant.strftime("%H:%M")
            for w in windows:
                if weekday in w.get("days",list(range(7))) and w.get("start","00:00")<=clock<=w.get("end","23:59"):
                    available=True;break
    except Exception: pass
    try:
        pricing=json.loads(item.price_schedule_json or "{}"); weekday=instant.weekday();clock=instant.strftime("%H:%M")
        for w in pricing.get("windows",[]) if isinstance(pricing,dict) else []:
            if weekday in w.get("days",list(range(7))) and w.get("start","00:00")<=clock<=w.get("end","23:59"):
                if "price" in w: price=Decimal(str(w["price"]))
                elif "multiplier" in w: price=(price*Decimal(str(w["multiplier"]))).quantize(Decimal("0.01"))
                break
    except Exception: pass
    return available,price


@router.get("/payment-methods")
def payment_methods(db: Session = Depends(get_db)):
    """Public, server-authoritative checkout capabilities; never quote a fee from the client."""
    online_only = settings.is_production and settings.require_online_payments
    cash_available = not online_only or settings.cash_checkout_enabled
    methods = [
        {"id": "cash", "label": "Efectivo", "enabled": cash_available,
         "service_fee_waived": not commercial_v152_active(), "collection": "on_delivery_or_pickup"},
        {"id": "mercadopago", "label": "Mercado Pago", "enabled": bool(settings.mercado_pago_access_token and settings.mercado_pago_webhook_secret),
         "service_fee_waived": False, "collection": "online"},
        {"id": "stripe", "label": "Tarjeta, Apple Pay o Google Pay", "enabled": bool(settings.stripe_enabled and settings.stripe_secret_key and settings.stripe_publishable_key and settings.stripe_webhook_secret),
         "service_fee_waived": False, "collection": "online"},
    ]
    policy162 = commercial_v162_active()
    rate = (commercial_value(db, 'commercial_v162.service_fee_rate', Decimal('0.25')) if policy162
            else commercial_value(db, 'commercial_v152.service_fee_rate', Decimal('0.25')) if commercial_v152_active() else None)
    delivery_base = (commercial_value(db, 'commercial_v162.base_delivery_fee', Decimal('10000')) if policy162
                     else commercial_value(db, 'commercial_v152.base_delivery_fee', Decimal('10000')) if commercial_v152_active() else None)
    service_cap = commercial_value(db, 'commercial_v162.service_fee_cap', Decimal('10000')) if policy162 else None
    return {
        "currency": "MXN", "methods": methods,
        "note": (
            f"Tarifa de servicio {rate * 100}% sobre comida neta, máximo ${service_cap} MXN en efectivo y pagos digitales; "
            "excluye envío y propinas. Envío calculado por distancia." if policy162 else
            f"La tarifa de servicio es {rate * 100}% de comida neta en efectivo y pagos digitales; no aplica a propinas ni envío."
            if commercial_v152_active() else
            "El efectivo no tiene tarifa de servicio; envío y propina se cobran por separado."
        ),
        "commercial_pricing_version": '1.6.2' if policy162 else '1.5.2' if commercial_v152_active() else 'legacy',
        "service_fee_rate": str(rate) if rate is not None else None,
        "service_fee_cap": str(service_cap) if policy162 else None,
        "delivery_base_fee": str(delivery_base) if delivery_base is not None else None,
        "delivery_included_km": (str(commercial_value(db, 'commercial_v162.included_km', Decimal('100'))) if policy162 else None),
        "delivery_additional_per_km": (str(commercial_value(db, 'commercial_v162.additional_per_km', Decimal('1000'))) if policy162 else None),
    }


def _checkout_fingerprint(payload: schemas.OrderCreate) -> str:
    """HMAC of the validated checkout intent, not of mutable price/stock.

    Includes gift card codes, scheduled time, item options and every other input
    accepted by OrderCreate. Store only the HMAC, never the raw intent/secret.
    """
    canonical = json.dumps(
        payload.model_dump(mode="json"), sort_keys=True,
        ensure_ascii=False, separators=(",", ":"),
    ).encode("utf-8")
    return hmac.new(settings.jwt_secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _assert_same_order_reference(
    db: Session, existing: models.Order, payload: schemas.OrderCreate,
) -> None:
    """A reused reference must prove the same original purchase or return 409.

    New orders have a durable HMAC written within the order transaction.
    Existing legacy orders have no stored fingerprint, so use a conservative
    persisted-fields comparison and fail closed for legacy gift-card redemptions.
    """
    event = db.scalar(
        select(models.OrderEvent)
        .where(models.OrderEvent.order_id == existing.id,
               models.OrderEvent.status == "received")
        .order_by(models.OrderEvent.id)
        .limit(1)
    )
    if event:
        try:
            saved = json.loads(event.metadata_json or "{}")
            fingerprint = saved.get("checkout_intent_hmac")
        except (TypeError, ValueError, AttributeError):
            fingerprint = None
        if fingerprint is not None:
            if (isinstance(fingerprint, str)
                    and hmac.compare_digest(fingerprint, _checkout_fingerprint(payload))):
                return
            raise HTTPException(409, "La referencia del pedido ya se uso con una compra diferente")

    # Legacy orders did not persist the gift-card code or original full intent.
    # Returning such an order on retry would claim unverifiable equivalence.
    if existing.payment_method == "gift_card":
        raise HTTPException(409, "Referencia de gift card anterior; consulta tus pedidos")

    saved_items = sorted(
        (item.menu_item_id, item.quantity, item.options_snapshot or "")
        for item in existing.items
    )
    incoming_items = sorted(
        (item.menu_item_id, item.quantity, item.options or "")
        for item in payload.items
    )
    equal = (
        existing.restaurant_id == payload.restaurant_id
        and existing.payment_method == payload.payment_method
        and existing.order_type == payload.order_type
        and existing.address == payload.address.strip()
        and existing.notes == payload.notes.strip()
        and Decimal(existing.tip) == Decimal(payload.tip)
        and existing.coupon_code == payload.coupon_code.upper().strip()
        and existing.group_code == payload.group_code.strip()
        and existing.invoice_requested == payload.invoice_requested
        and existing.invoice_tax_id == payload.invoice_tax_id
        and existing.recipient_name == payload.recipient_name.strip()
        and existing.recipient_phone == payload.recipient_phone.strip()
        and existing.gift_message == payload.gift_message.strip()
        and existing.corporate_account_id == payload.corporate_account_id
        and _utc(existing.scheduled_for) == _utc(payload.scheduled_for)
        and existing.delivery_lat == payload.delivery_lat
        and existing.delivery_lng == payload.delivery_lng
        and saved_items == incoming_items
    )
    if not equal:
        raise HTTPException(409, "La referencia del pedido ya se uso con una compra diferente")


@router.post("",response_model=schemas.OrderPublic,status_code=201)
def create_order(payload:schemas.OrderCreate,user:models.User=Depends(require_role("customer","admin")),db:Session=Depends(get_db)):
    if (settings.is_production and settings.require_online_payments
            and payload.payment_method not in {"mercadopago", "stripe"}
            and not (payload.payment_method == "cash" and settings.cash_checkout_enabled)):
        if settings.stripe_enabled:
            raise HTTPException(400,"Se requiere Mercado Pago o Stripe como método de pago en línea")
        raise HTTPException(400,"La V1 de producción acepta pagos en línea mediante Mercado Pago")
    if payload.payment_method == "stripe" and not (settings.stripe_enabled and settings.stripe_secret_key and settings.stripe_webhook_secret):
        raise HTTPException(503,"Stripe no está configurado en este servidor")
    if payload.client_reference:
        # Serialize concurrent checkouts for this customer on the primary DB.
        # PostgreSQL's READ COMMITTED then sees the just-committed reference
        # from another worker. Lock BEFORE querying the reference; handling
        # IntegrityError only at db.commit() is too late (db.flush() inserts).
        db.scalar(
            select(models.User.id)
            .where(models.User.id == user.id)
            .with_for_update()
        )
        existing=db.scalar(select(models.Order).where(models.Order.user_id==user.id,models.Order.client_reference==payload.client_reference).options(*order_options()))
        if existing:
            _assert_same_order_reference(db, existing, payload)
            return existing
    restaurant=db.get(models.Restaurant,payload.restaurant_id)
    if not restaurant:
        raise HTTPException(404,"Restaurante no encontrado")
    if not restaurant.is_open:
        raise HTTPException(400,"El restaurante está cerrado")
    if payload.order_type=="pickup" and not restaurant.pickup_enabled:
        raise HTTPException(400,"Este restaurante no permite recoger")

    distance_km = 0.0
    if payload.order_type == "delivery":
        if payload.delivery_lat is not None and payload.delivery_lng is not None:
            distance_km = round(haversine_km(restaurant.lat, restaurant.lng, payload.delivery_lat, payload.delivery_lng), 2)
        elif settings.is_production:
            raise HTTPException(400, "Selecciona tu ubicación exacta para calcular cobertura y tarifa")
        else:
            distance_km = payload.distance_km
        if distance_km > restaurant.delivery_radius_km:
            raise HTTPException(400, "Dirección fuera de la zona de cobertura")

    if len(payload.items) > settings.max_order_items:
        raise HTTPException(400, f"Un pedido admite como máximo {settings.max_order_items} líneas")
    ids=[x.menu_item_id for x in payload.items]
    rows=db.scalars(select(models.MenuItem).where(models.MenuItem.id.in_(ids),models.MenuItem.restaurant_id==restaurant.id).order_by(models.MenuItem.id).with_for_update()).all()
    menu={x.id:x for x in rows}
    if len(menu)!=len(set(ids)):
        raise HTTPException(400,"Uno o más productos no pertenecen al restaurante")

    subtotal=Decimal("0")
    ingredient_usage={}
    effective_prices={}
    pricing_instant=payload.scheduled_for or datetime.now(timezone.utc)
    recipe_rows = db.scalars(select(models.MenuRecipe).where(models.MenuRecipe.menu_item_id.in_(ids))).all()
    recipes_by_item = {}
    for recipe in recipe_rows:
        recipes_by_item.setdefault(recipe.menu_item_id, []).append(recipe)
    for req in payload.items:
        item=menu[req.menu_item_id]
        available,effective_price=_effective_item(item,pricing_instant)
        if not available or item.stock < req.quantity:
            raise HTTPException(400,f"{item.name} no está disponible en el horario seleccionado o no tiene stock suficiente")
        effective_prices[item.id]=effective_price
        for recipe in recipes_by_item.get(item.id, []):
            needed=Decimal(recipe.quantity_required)*req.quantity
            ingredient_usage[recipe.ingredient_id]=ingredient_usage.get(recipe.ingredient_id,Decimal("0"))+needed
        subtotal += effective_price*req.quantity
    ingredient_rows = {}
    if ingredient_usage:
        locked_ingredients = db.scalars(
            select(models.IngredientStock)
            .where(models.IngredientStock.id.in_(ingredient_usage))
            .order_by(models.IngredientStock.id)
            .with_for_update()
        ).all()
        ingredient_rows = {row.id: row for row in locked_ingredients}
    for ingredient_id,needed in ingredient_usage.items():
        ingredient=ingredient_rows.get(ingredient_id)
        if not ingredient or Decimal(ingredient.quantity)<needed:
            raise HTTPException(400,"Inventario de ingredientes insuficiente para completar el pedido")

    discount=_coupon_discount(db,payload.coupon_code,subtotal)
    account=get_loyalty_account(db,user.id,lock=True)
    fee=Decimal("0") if payload.order_type=="pickup" else effective_delivery_fee(db, restaurant, distance_km)
    original_fee=fee.quantize(Decimal("0.01"))
    if account.plus_member and payload.order_type=="delivery":
        fee=(fee*Decimal("0.50")).quantize(Decimal("0.01"))
        account.plus_savings=(Decimal(account.plus_savings or 0)+(original_fee-fee)).quantize(Decimal("0.01"))
    fee=fee.quantize(Decimal("0.01"))
    economics=calculate_order_economics(db,restaurant,subtotal,discount,fee,payload.tip,payload.payment_method,merchant_managed_delivery=(settings.merchant_managed_delivery and payload.order_type=="delivery"),order_type=payload.order_type,distance_km=distance_km)
    total=economics["total"]

    card=None
    corporate_account=None
    if payload.payment_method=="gift_card":
        card=db.scalar(select(models.GiftCard).where(models.GiftCard.code==payload.gift_card_code.upper().strip()).with_for_update())
        if not card or not card.active or card.balance < total:
            raise HTTPException(400,"Gift Card inválida o con saldo insuficiente")
    if payload.payment_method=="corporate":
        if not payload.corporate_account_id:
            raise HTTPException(400,"Selecciona una cuenta empresarial")
        membership=db.scalar(select(models.CorporateMember).where(models.CorporateMember.corporate_account_id==payload.corporate_account_id,models.CorporateMember.user_id==user.id,models.CorporateMember.active.is_(True)))
        corporate_account=db.scalar(
            select(models.CorporateAccount)
            .where(models.CorporateAccount.id==payload.corporate_account_id)
            .with_for_update()
        )
        if not membership or not corporate_account or not corporate_account.active:
            raise HTTPException(403,"No perteneces a esa cuenta empresarial")
        month_start=datetime.now(timezone.utc).replace(day=1,hour=0,minute=0,second=0,microsecond=0)
        spent=db.scalar(select(func.coalesce(func.sum(models.Order.total),0)).where(models.Order.corporate_account_id==corporate_account.id,models.Order.created_at>=month_start,models.Order.status!="cancelled")) or 0
        budget=Decimal(membership.individual_budget or 0) or Decimal(corporate_account.monthly_budget or 0)
        if budget>0 and Decimal(spent)+total>budget:
            raise HTTPException(409,"El pedido supera el presupuesto empresarial disponible")

    commission=economics["platform_commission"]
    driver_earning=economics["driver_earning"] if payload.order_type=="delivery" else Decimal("0")
    payment_status = "paid" if payload.payment_method in {"wallet", "gift_card"} else ("corporate_pending" if payload.payment_method=="corporate" else "pending")
    order=models.Order(
        user_id=user.id,restaurant_id=restaurant.id,status="received",address=payload.address.strip(),notes=payload.notes.strip(),
        delivery_fee=fee,tip=payload.tip,payment_method=payload.payment_method,payment_status=payment_status,
        payment_provider="mercadopago" if payload.payment_method=="mercadopago" else payload.payment_method,
        subtotal=subtotal,discount=discount,total=total,platform_commission=commission,
        service_fee=economics["service_fee"],payment_processing_fee=economics["payment_processing_fee"],promotion_subsidy=economics["promotion_subsidy"],
        platform_revenue=economics["platform_revenue"],contribution_margin=economics["contribution_margin"],
        restaurant_payout=economics["restaurant_payout"],driver_earning=driver_earning,order_type=payload.order_type,
        scheduled_for=payload.scheduled_for,coupon_code=payload.coupon_code.upper().strip(),group_code=payload.group_code.strip(),
        distance_km=distance_km,delivery_lat=payload.delivery_lat,delivery_lng=payload.delivery_lng,
        estimated_minutes=restaurant.eta_min+(0 if payload.order_type=="pickup" else int(distance_km*3)),
        invoice_requested=payload.invoice_requested,invoice_tax_id=payload.invoice_tax_id,client_reference=payload.client_reference,
        recipient_name=payload.recipient_name.strip(),recipient_phone=payload.recipient_phone.strip(),gift_message=payload.gift_message.strip(),corporate_account_id=payload.corporate_account_id,
        inventory_reserved_json=json.dumps({str(k): str(v) for k, v in ingredient_usage.items()}, sort_keys=True),
    )
    db.add(order); db.flush()
    enqueue_event(
        db,
        event_key=f"order:{order.id}:created",
        aggregate_type="order",
        aggregate_id=order.id,
        event_type="order.created",
        payload={"order_id": order.id, "status": order.status, "payment_status": order.payment_status, "user_id": user.id, "restaurant_id": restaurant.id},
    )

    if payload.payment_method=="wallet":
        debit_wallet(
            db,user.id,total,kind="order_payment",reference_type="order",reference_id=str(order.id),
            description=f"Pago de pedido #{order.id}",idempotency_key=f"order:{order.id}:wallet:debit",account=account,
        )
    elif payload.payment_method=="gift_card" and card:
        card.balance -= total
        if card.balance <= 0:
            card.active=False

    for req in payload.items:
        item=menu[req.menu_item_id]
        item.stock-=req.quantity
        db.add(models.OrderItem(order_id=order.id,menu_item_id=item.id,name_snapshot=item.name,quantity=req.quantity,unit_price=effective_prices[item.id],options_snapshot=req.options))
    for ingredient_id,needed in ingredient_usage.items():
        ingredient=ingredient_rows.get(ingredient_id)
        if ingredient:
            ingredient.quantity=max(Decimal("0"),Decimal(ingredient.quantity)-needed)

    db.add(models.Notification(user_id=user.id,kind="order",title="Pedido recibido",message=f"Tu pedido #{order.id} llegó a {restaurant.name}."))
    # Notify restaurant only for immediately actionable non-provider checkout.
    # Online payment orders notify owner after a verified provider webhook.
    if payload.payment_method not in {"stripe", "mercadopago"}:
        db.add(models.Notification(user_id=restaurant.owner_id, kind="restaurant_order",
                                   title="Nuevo pedido", message=f"Pedido #{order.id} recibido en {restaurant.name}."))
    initial_event = {"source": "checkout"}
    if payload.client_reference:
        initial_event["checkout_intent_hmac"] = _checkout_fingerprint(payload)
    db.add(models.OrderEvent(
        order_id=order.id, status="received", actor_user_id=user.id,
        metadata_json=json.dumps(initial_event, sort_keys=True),
    ))
    post_order_ledger(db,order)
    if feature_enabled(db, "security.fraud_v14", user_id=user.id, role="customer", default=True):
        flag_order_if_needed(db, order)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if payload.client_reference:
            existing = db.scalar(
                select(models.Order)
                .where(models.Order.user_id == user.id, models.Order.client_reference == payload.client_reference)
                .options(*order_options())
            )
            if existing:
                _assert_same_order_reference(db, existing, payload)
                return existing
        raise
    publish_order_event(order.id,"order.created",{"status":order.status,"payment_status":order.payment_status})
    return _load_order(db,order.id)


@router.get("/by-reference/{client_reference}", response_model=schemas.OrderPublic)
def order_by_client_reference(
    response: Response,
    client_reference: str = Path(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$"),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Recover only this signed-in user's own order after a lost POST response.

    An unknown reference and another customer's reference both produce 404.
    This endpoint is read-only: it does not retry checkout or provider payments.
    """
    response.headers["Cache-Control"] = "private, no-store"
    order = db.scalar(
        select(models.Order)
        .where(
            models.Order.user_id == user.id,
            models.Order.client_reference == client_reference,
        )
        .options(*order_options())
    )
    if order is None:
        raise HTTPException(404, "Pedido no encontrado")
    return order


@router.get("/mine",response_model=list[schemas.OrderPublic])
def my_orders(
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=1_000_000),
    user:models.User=Depends(get_current_user),
    db:Session=Depends(get_db),
):
    return db.scalars(
        select(models.Order)
        .where(models.Order.user_id==user.id)
        .options(*order_options())
        .order_by(models.Order.created_at.desc())
        .offset(offset)
        .limit(limit)
    ).all()


@router.post("/{order_id}/cancel",response_model=schemas.OrderPublic)
def cancel(order_id:int,reason:str="Cambio de planes",user:models.User=Depends(require_role("customer","admin")),db:Session=Depends(get_db)):
    order=_load_order(db,order_id,lock=True)
    if not order or (user.role!="admin" and order.user_id!=user.id):
        raise HTTPException(404,"Pedido no encontrado")
    # Repeated cancel requests are intentionally idempotent. Without this guard an
    # ADMIN retry could restore the same inventory more than once.
    if order.status == "cancelled":
        return order
    cancellable={"received":Decimal("0.00"),"confirmed":Decimal("0.10"),"preparing":Decimal("0.30")}
    if user.role!="admin" and order.status not in cancellable:
        raise HTTPException(400,"El pedido ya no puede cancelarse automáticamente; abre una disputa o contacta soporte")
    fee_rate=Decimal("0") if user.role=="admin" else cancellable.get(order.status,Decimal("0"))
    cancellation_fee=(Decimal(order.subtotal-order.discount)*fee_rate).quantize(Decimal("0.01"))
    order.cancellation_fee=cancellation_fee
    if order.payment_method in {"mercadopago", "stripe"} and order.payment_status in {"paid", "partially_refunded"}:
        raise HTTPException(409,"El pedido ya fue pagado. Solicita el reembolso desde soporte o ADMIN para conservar la conciliación del proveedor de pago.")

    restore_order_inventory(db, order)

    if order.payment_status == "paid" and order.payment_method in {"wallet", "gift_card"}:
        account=get_loyalty_account(db,order.user_id,lock=True)
        refund=max(Decimal("0"),Decimal(order.total)-cancellation_fee)
        credit_wallet(
            db,order.user_id,refund,kind="order_refund",reference_type="order",reference_id=str(order.id),
            description=f"Reembolso por cancelación del pedido #{order.id}",idempotency_key=f"order:{order.id}:wallet:refund",account=account,
        )
        order.refunded_amount=max(Decimal("0"),Decimal(order.total)-cancellation_fee)
        order.payment_status="refunded" if cancellation_fee == 0 else "partially_refunded"
        if cancellation_fee>0:
            order.restaurant_payout=(Decimal(order.restaurant_payout)+cancellation_fee*Decimal("0.80")).quantize(Decimal("0.01"))
            order.platform_revenue=(Decimal(order.platform_revenue)+cancellation_fee*Decimal("0.20")).quantize(Decimal("0.01"))
            order.contribution_margin=(Decimal(order.contribution_margin)+cancellation_fee*Decimal("0.20")).quantize(Decimal("0.01"))
        db.add(models.Notification(user_id=order.user_id,kind="wallet",title="Saldo reembolsado",message=f"${refund} regresaron a tu Tala Wallet por la cancelación del pedido #{order.id}."))

    db.add(models.OrderEvent(order_id=order.id,status="cancelled",actor_user_id=user.id,metadata_json=f'{{"cancellation_fee":"{cancellation_fee}"}}'))
    order.status="cancelled"
    order.cancelled_reason=reason[:300]
    db.commit()
    publish_order_event(order.id,"order.status",{"status":"cancelled","payment_status":order.payment_status})
    return _load_order(db,order_id)


@router.get("/{order_id}/cancellation-preview")
def cancellation_preview(order_id:int,user:models.User=Depends(require_role("customer","admin")),db:Session=Depends(get_db)):
    order=_load_order(db,order_id)
    if not order or (user.role!="admin" and order.user_id!=user.id): raise HTTPException(404,"Pedido no encontrado")
    rates={"received":Decimal("0.00"),"confirmed":Decimal("0.10"),"preparing":Decimal("0.30")}
    if order.status not in rates and user.role!="admin": return {"cancellable":False,"reason":"Requiere revisión de soporte","fee":"0.00"}
    rate=Decimal("0") if user.role=="admin" else rates.get(order.status,Decimal("0"))
    fee=(Decimal(order.subtotal-order.discount)*rate).quantize(Decimal("0.01"))
    return {"cancellable":True,"status":order.status,"fee":str(fee),"refund_estimate":str(max(Decimal("0"),Decimal(order.total)-fee)),"policy":"received=gratis, confirmed=10%, preparing=30%; estados posteriores requieren soporte"}


@router.post("/{order_id}/reorder",response_model=dict)
def reorder(order_id:int,user:models.User=Depends(require_role("customer")),db:Session=Depends(get_db)):
    order=_load_order(db,order_id)
    if not order or order.user_id!=user.id:
        raise HTTPException(404,"Pedido no encontrado")
    return {"restaurant_id":order.restaurant_id,"items":[{"menu_item_id":i.menu_item_id,"quantity":i.quantity} for i in order.items if i.menu_item_id]}


@router.get("/{order_id}",response_model=None)
def detail(order_id:int,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    order=_load_order(db,order_id)
    if not order:
        raise HTTPException(404,"Pedido no encontrado")
    rest=db.get(models.Restaurant,order.restaurant_id)
    allowed=user.role=="admin" or order.user_id==user.id or order.driver_id==user.id or (user.role=="restaurant" and rest and rest.owner_id==user.id)
    if not allowed:
        raise HTTPException(403,"No tienes acceso a este pedido")
    schema = schemas.OrderPublic if order.user_id == user.id else schemas.OrderOperationalPublic
    return schema.model_validate(order).model_dump(mode="json")
