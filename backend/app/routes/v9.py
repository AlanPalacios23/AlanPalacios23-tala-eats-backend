from __future__ import annotations

import hashlib
import json
import math
import secrets
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy import case, func, select, text
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas
from ..db import get_db
from ..deps import get_current_user, require_role
from ..geo import haversine_km
from ..security import generate_totp_secret, verify_totp
from ..email_service import enqueue_email
from ..config import settings
from ..realtime import driver_locations, redis_ping
from ..geo_postgis import nearest_online_driver_ids
from ..feature_flags import enabled as feature_enabled
from .orders import _effective_item

router = APIRouter(prefix="/api/v1/v9", tags=["v9-intelligence-growth-automation"])


def now():
    return datetime.now(timezone.utc)


def _aware(value):
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _owner_restaurant(db: Session, user: models.User) -> models.Restaurant:
    row = db.scalar(select(models.Restaurant).where(models.Restaurant.owner_id == user.id))
    if not row:
        raise HTTPException(404, "No tienes un restaurante asignado")
    return row


def _segment_for_user(db: Session, user_id: int) -> dict:
    """Return CRM segmentation without hydrating a user's complete order history."""
    instant = now()
    delivered_count, spend = db.execute(
        select(
            func.count(models.Order.id),
            func.coalesce(func.sum(models.Order.total), 0),
        ).where(models.Order.user_id == user_id, models.Order.status == "delivered")
    ).one()
    last = db.scalar(
        select(models.Order.created_at)
        .where(models.Order.user_id == user_id)
        .order_by(models.Order.created_at.desc())
        .limit(1)
    )
    delivered_count = int(delivered_count or 0)
    spend = Decimal(spend or 0)
    last = _aware(last) if last else None
    days = (instant - last).days if last else 9999
    if delivered_count == 0:
        segment = "new"
    elif delivered_count >= 20 or spend >= Decimal("8000"):
        segment = "vip"
    elif days >= 30:
        segment = "inactive"
    elif days >= 14:
        segment = "at_risk"
    elif delivered_count >= 5:
        segment = "frequent"
    else:
        segment = "active"
    return {
        "segment": segment,
        "orders": delivered_count,
        "lifetime_value": str(spend.quantize(Decimal("0.01"))),
        "days_since_last_order": None if last is None else days,
    }


def _bulk_segments(db: Session, user_ids: list[int]) -> dict[int, dict]:
    """Compute CRM profiles for many users with one aggregate query."""
    if not user_ids:
        return {}
    delivered_case = case((models.Order.status == "delivered", 1), else_=0)
    spend_case = case((models.Order.status == "delivered", models.Order.total), else_=Decimal("0"))
    rows = db.execute(
        select(
            models.Order.user_id,
            func.sum(delivered_case),
            func.coalesce(func.sum(spend_case), 0),
            func.max(models.Order.created_at),
        )
        .where(models.Order.user_id.in_(user_ids))
        .group_by(models.Order.user_id)
    ).all()
    stats = {uid: (int(count or 0), Decimal(spend or 0), _aware(last) if last else None) for uid, count, spend, last in rows}
    instant = now()
    result = {}
    for uid in user_ids:
        delivered_count, spend, last = stats.get(uid, (0, Decimal("0"), None))
        days = (instant - last).days if last else 9999
        if delivered_count == 0:
            segment = "new"
        elif delivered_count >= 20 or spend >= Decimal("8000"):
            segment = "vip"
        elif days >= 30:
            segment = "inactive"
        elif days >= 14:
            segment = "at_risk"
        elif delivered_count >= 5:
            segment = "frequent"
        else:
            segment = "active"
        result[uid] = {
            "segment": segment,
            "orders": delivered_count,
            "lifetime_value": str(spend.quantize(Decimal("0.01"))),
            "days_since_last_order": None if last is None else days,
        }
    return result

def _loyalty_tier(points: int, delivered: int) -> str:
    score = points + delivered * 25
    if score >= 3000: return "BLACK"
    if score >= 1500: return "GOLD"
    if score >= 600: return "SILVER"
    return "BRONZE"


def _order_eta(order: models.Order, db: Session) -> dict:
    base = int(order.estimated_minutes or 30)
    restaurant = db.get(models.Restaurant, order.restaurant_id)
    active = db.scalar(select(func.count(models.Order.id)).where(models.Order.restaurant_id == order.restaurant_id, models.Order.status.in_(["received","confirmed","preparing","ready","assigned","picked_up","on_the_way"]))) or 0
    load_penalty = max(0, active - 3) * 3
    hour = now().hour
    traffic_factor = 1.25 if hour in {7,8,9,13,14,15,18,19,20,21} else 1.0
    elapsed = max(0, int((now() - _aware(order.created_at)).total_seconds() / 60))
    if order.status in {"received", "confirmed", "preparing"}:
        prep = max(5, int((restaurant.eta_min if restaurant else base) + load_penalty - elapsed * 0.25))
        travel = max(7, int(order.distance_km * 4 * traffic_factor)) if order.order_type == "delivery" else 0
        remaining = prep + travel
    elif order.status in {"ready", "assigned"}:
        remaining = max(7, int(order.distance_km * 4 * traffic_factor) + load_penalty)
    elif order.status == "picked_up":
        remaining = max(5, int(order.distance_km * 3.5 * traffic_factor))
    elif order.status == "on_the_way":
        remaining = max(3, int(order.distance_km * 2.7 * traffic_factor))
    elif order.status == "delivered":
        remaining = 0
    else:
        remaining = max(0, base - elapsed)
    confidence = "high" if order.status in {"picked_up","on_the_way"} else "medium"
    return {"order_id": order.id, "status": order.status, "eta_minutes": remaining, "confidence": confidence, "restaurant_load": active, "traffic_factor": traffic_factor, "traffic_source":"peak-hour-heuristic-v1", "calculated_at": now()}


def _dispatch_candidates(order: models.Order, db: Session):
    """Score available verified drivers with O(1) aggregate queries, not N+1."""
    restaurant = db.get(models.Restaurant, order.restaurant_id)
    driver_stmt = (
        select(models.User, models.DriverProfile)
        .join(models.DriverProfile, models.DriverProfile.user_id == models.User.id)
        .where(
            models.User.role == "driver",
            models.User.is_active.is_(True),
            models.DriverProfile.is_online.is_(True),
            models.DriverProfile.is_verified.is_(True),
        )
    )
    use_v2 = feature_enabled(db, "dispatch.v2", role="driver", default=True)
    use_postgis = feature_enabled(db, "geo.postgis", role="all", default=False)
    geo_shortlist = nearest_online_driver_ids(db, restaurant.lat, restaurant.lng, radius_km=max(15.0, restaurant.delivery_radius_km * 2), limit=100) if restaurant and use_postgis else None
    if geo_shortlist is not None:
        if not geo_shortlist:
            return []
        driver_stmt = driver_stmt.where(models.User.id.in_(geo_shortlist))
    rows = db.execute(driver_stmt).all()
    driver_ids = [driver.id for driver, _ in rows]
    active_counts: dict[int, int] = {}
    if driver_ids:
        active_counts = {
            int(driver_id): int(count)
            for driver_id, count in db.execute(
                select(models.Order.driver_id, func.count(models.Order.id))
                .where(
                    models.Order.driver_id.in_(driver_ids),
                    models.Order.status.in_(["assigned", "picked_up", "on_the_way"]),
                )
                .group_by(models.Order.driver_id)
            ).all()
            if driver_id is not None
        }
    latest_delivery = {}
    offer_stats = {}
    if driver_ids:
        latest_delivery = {
            int(driver_id): delivered_at
            for driver_id, delivered_at in db.execute(
                select(models.Order.driver_id, func.max(models.Order.delivered_at))
                .where(models.Order.driver_id.in_(driver_ids), models.Order.status == "delivered")
                .group_by(models.Order.driver_id)
            ).all() if driver_id is not None
        }
        since = now() - timedelta(days=30)
        offer_stats = {
            int(driver_id): (int(accepted or 0), int(rejected or 0))
            for driver_id, accepted, rejected in db.execute(
                select(
                    models.DriverOffer.driver_id,
                    func.sum(case((models.DriverOffer.status == "accepted", 1), else_=0)),
                    func.sum(case((models.DriverOffer.status == "rejected", 1), else_=0)),
                )
                .where(models.DriverOffer.driver_id.in_(driver_ids), models.DriverOffer.offered_at >= since)
                .group_by(models.DriverOffer.driver_id)
            ).all()
        }
    cached_locations = driver_locations(driver_ids)
    candidates = []
    instant = now()
    for driver, profile in rows:
        cached = cached_locations.get(driver.id)
        driver_lat = cached[0] if cached else profile.current_lat
        driver_lng = cached[1] if cached else profile.current_lng
        if driver_lat is not None and driver_lng is not None and restaurant:
            distance = haversine_km(driver_lat, driver_lng, restaurant.lat, restaurant.lng)
        else:
            distance = 99.0
        active_count = active_counts.get(driver.id, 0)
        accepted, rejected = offer_stats.get(driver.id, (0, 0))
        acceptance_rate = accepted / max(1, accepted + rejected) if accepted + rejected else 0.90
        last = _aware(latest_delivery.get(driver.id))
        idle_minutes = min(180.0, max(0.0, (instant - last).total_seconds() / 60)) if last else 180.0
        fairness_bonus = min(12.0, idle_minutes / 15.0)
        eta_pickup_min = max(3, int(round(distance / 25.0 * 60 + 3))) if distance < 90 else 999
        if use_v2:
            # V14: proximity + ETA + availability + quality + acceptance + fairness.
            # Single-active-delivery protection remains the hard safety rule.
            score = max(0.0,
                115 - distance * 8.5 - eta_pickup_min * 0.7 - active_count * 25
                + float(profile.rating or 5) * 4 + acceptance_rate * 8 + fairness_bonus
            )
            engine_name = "dispatch-v2-fairness-eta"
        else:
            acceptance_proxy = min(1.0, 0.75 + min(profile.total_deliveries, 100) / 500)
            score = max(0.0, 100 - distance * 8 - active_count * 18 + float(profile.rating or 5) * 4 + acceptance_proxy * 5)
            engine_name = "dispatch-v1-fallback"
        candidates.append({
            "driver_id": driver.id,
            "name": driver.name,
            "distance_km": round(distance, 2),
            "estimated_pickup_min": eta_pickup_min,
            "active_deliveries": active_count,
            "rating": float(profile.rating or 5),
            "acceptance_rate": round(acceptance_rate, 3),
            "idle_minutes": round(idle_minutes, 1),
            "score": round(score, 2),
            "engine": engine_name,
        })
    return sorted(candidates, key=lambda x: x["score"], reverse=True)


def _claim_dispatch_driver(db: Session, candidates: list[dict], *, exclude: int | None = None) -> dict | None:
    """Lock and re-check a driver before assigning an order."""
    for candidate in candidates:
        driver_id = int(candidate["driver_id"])
        if exclude is not None and driver_id == exclude:
            continue
        profile = db.scalar(
            select(models.DriverProfile)
            .where(
                models.DriverProfile.user_id == driver_id,
                models.DriverProfile.is_online.is_(True),
                models.DriverProfile.is_verified.is_(True),
            )
            .with_for_update(skip_locked=True)
        )
        if not profile:
            continue
        busy = db.scalar(
            select(models.Order.id)
            .where(
                models.Order.driver_id == driver_id,
                models.Order.status.in_(["assigned", "picked_up", "on_the_way"]),
            )
            .limit(1)
        )
        if not busy:
            return candidate
    return None


def _risk_signals(db: Session, user: models.User) -> list[str]:
    signals=[]
    refunds = db.scalar(select(func.count(models.Dispute.id)).where(models.Dispute.opened_by_user_id==user.id, models.Dispute.refund_amount>0)) or 0
    orders = db.scalar(select(func.count(models.Order.id)).where(models.Order.user_id==user.id)) or 0
    cancelled = db.scalar(select(func.count(models.Order.id)).where(models.Order.user_id==user.id, models.Order.status=="cancelled")) or 0
    if refunds >= 3: signals.append("multiple_refunds")
    if orders >= 3 and cancelled / max(orders,1) > .45: signals.append("high_cancellation_rate")
    if user.email.count("+") > 0: signals.append("email_alias")
    return signals


@router.get("/overview")
def overview():
    return {
        "version":"9.0.0-intelligence-growth-automation",
        "theme":"Intelligence + Growth + Automation",
        "capabilities":112,
        "engines":{
            "dispatch":"scoring-v1","eta":"dynamic-v1","demand_forecast":"historical-moving-average","recommendations":"behavioral-rules-v1","smart_search":"intent-rules-v1","fraud":"signals-v1"
        },
        "note":"Los motores V9 funcionan sin proveedor ML externo; pueden reemplazarse por modelos avanzados cuando exista suficiente histórico validado."
    }


# ---------------------------------------------------------------------------
# Product analytics, experiments and customer intelligence
# ---------------------------------------------------------------------------
@router.post("/events", status_code=202)
def track_event(payload: schemas.ProductEventCreate, request: Request, db: Session=Depends(get_db)):
    user_id=None
    try:
        from ..deps import get_current_user as _unused
        # Authentication is intentionally optional for pre-login funnel events.
        token=request.cookies.get("talaeats_session")
        if token:
            from ..security import decode_access_token
            user_id=int(decode_access_token(token)["sub"])
    except Exception:
        user_id=None
    db.add(models.ProductEvent(user_id=user_id,session_id=payload.session_id,event_name=payload.event_name,route=payload.route,properties_json=json.dumps(payload.properties,ensure_ascii=False)[:8000]))
    db.commit();return {"accepted":True}


@router.get("/search")
def smart_search(
    q: str = "",
    max_price: float | None = None,
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
):
    query=(q or "").lower().strip()
    terms=[t for t in query.replace(","," ").split() if len(t)>1]
    healthy=any(x in query for x in ["saludable","healthy","light","ensalada","proteina"])
    cheap=any(x in query for x in ["barato","económico","economico","menos de","budget"])
    breakfast=any(x in query for x in ["desayuno","breakfast","café","cafe"])
    family=any(x in query for x in ["familia","4 personas","compartir","grupo"])

    # Bound the candidate set and fetch menu items in one query instead of one
    # query per restaurant. This keeps search predictable as the catalog grows.
    rows=db.scalars(
        select(models.Restaurant)
        .where(models.Restaurant.is_open.is_(True))
        .order_by(models.Restaurant.sponsored.desc(), models.Restaurant.rating.desc(), models.Restaurant.id)
        .limit(max(100, settings.max_page_size))
    ).all()
    restaurant_ids=[r.id for r in rows]
    item_stmt=select(models.MenuItem).where(
        models.MenuItem.restaurant_id.in_(restaurant_ids),
        models.MenuItem.is_available.is_(True),
    ) if restaurant_ids else None
    if item_stmt is not None and max_price is not None:
        item_stmt=item_stmt.where(models.MenuItem.price <= Decimal(str(max_price)))
    menu_by_restaurant=defaultdict(list)
    if item_stmt is not None:
        for item in db.scalars(item_stmt.order_by(models.MenuItem.restaurant_id, models.MenuItem.id)).all():
            menu_by_restaurant[item.restaurant_id].append(item)

    results=[]
    for r in rows:
        matched=[]
        restaurant_hay=f"{r.name} {r.cuisine}".lower()
        for item in menu_by_restaurant.get(r.id, []):
            hay=f"{item.name} {item.description} {item.category} {item.dietary_tags}".lower()
            score=sum(4 for t in terms if t in hay)+sum(2 for t in terms if t in restaurant_hay)
            if healthy and any(x in hay for x in ["veg","ensalada","pollo","protein","salud"]): score+=5
            if breakfast and any(x in hay for x in ["café","cafe","huevo","desayuno","pan"]): score+=5
            if family and (item.is_combo or "combo" in hay or "familiar" in hay): score+=5
            if cheap and float(item.price)<=180: score+=3
            if score>0 or not terms: matched.append((score,item))
        matched=sorted(matched,key=lambda x:(x[0],-float(x[1].price)),reverse=True)[:6]
        if matched:
            results.append({"restaurant":{"id":r.id,"name":r.name,"cuisine":r.cuisine,"rating":float(r.rating),"eta_min":r.eta_min,"delivery_fee":float(r.delivery_fee)},"items":[{"id":i.id,"name":i.name,"price":float(i.price),"category":i.category,"score":score} for score,i in matched],"score":sum(x[0] for x in matched)+float(r.rating)})
    return {"query":q,"intent":{"healthy":healthy,"cheap":cheap,"breakfast":breakfast,"family":family,"max_price":max_price},"results":sorted(results,key=lambda x:x["score"],reverse=True)[:limit]}


@router.get("/recommendations")
def recommendations(user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    history=db.scalars(select(models.Order).where(models.Order.user_id==user.id,models.Order.status=="delivered").order_by(models.Order.created_at.desc()).limit(30)).all()
    counts=Counter(o.restaurant_id for o in history)
    favorites=db.scalars(select(models.Favorite.restaurant_id).where(models.Favorite.user_id==user.id)).all()
    rows=db.scalars(select(models.Restaurant).where(models.Restaurant.is_open.is_(True)).order_by(models.Restaurant.sponsored.desc(),models.Restaurant.rating.desc(),models.Restaurant.id).limit(max(100,settings.max_page_size))).all()
    hour=now().hour
    ranked=[]
    for r in rows:
        score=float(r.rating)*2 + counts.get(r.id,0)*5 + (6 if r.id in favorites else 0) + (2 if r.sponsored else 0)
        if hour<11 and any(k in r.cuisine.lower() for k in ["cafe","café","desayuno"]): score+=4
        ranked.append({"id":r.id,"name":r.name,"cuisine":r.cuisine,"rating":float(r.rating),"eta_min":r.eta_min,"delivery_fee":float(r.delivery_fee),"reason":"Tus hábitos" if counts.get(r.id) else ("Favorito" if r.id in favorites else "Popular cerca"),"score":round(score,2)})
    return {"segment":_segment_for_user(db,user.id),"restaurants":sorted(ranked,key=lambda x:x["score"],reverse=True)[:12]}


@router.get("/loyalty/status")
def loyalty_status(user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    acc=db.scalar(select(models.LoyaltyAccount).where(models.LoyaltyAccount.user_id==user.id))
    if not acc: raise HTTPException(404,"Cuenta Rewards no encontrada")
    delivered=db.scalar(select(func.count(models.Order.id)).where(models.Order.user_id==user.id,models.Order.status=="delivered")) or 0
    tier=_loyalty_tier(acc.points,delivered)
    if acc.tier!=tier: acc.tier=tier;db.commit()
    next_target={"BRONZE":600,"SILVER":1500,"GOLD":3000,"BLACK":3000}[tier]
    return {"tier":tier,"points":acc.points,"streak_days":acc.streak_days,"plus_member":acc.plus_member,"plus_savings":str(acc.plus_savings),"progress_score":acc.points+delivered*25,"next_target":next_target,"benefits":{"BRONZE":["Rewards base"],"SILVER":["Rewards x1.1","ofertas privadas"],"GOLD":["Rewards x1.25","prioridad de soporte"],"BLACK":["Rewards x1.5","beneficios premium"]}[tier]}


@router.get("/plus/value")
def plus_value(user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    acc=db.scalar(select(models.LoyaltyAccount).where(models.LoyaltyAccount.user_id==user.id))
    delivered=db.scalars(select(models.Order).where(models.Order.user_id==user.id,models.Order.status=="delivered").order_by(models.Order.created_at.desc()).limit(50)).all()
    estimated=sum((Decimal(o.delivery_fee or 0) for o in delivered),Decimal("0"))*Decimal("0.45") if acc and acc.plus_member else Decimal("0")
    if acc and estimated>acc.plus_savings: acc.plus_savings=estimated;db.commit()
    return {"active":bool(acc and acc.plus_member),"estimated_savings":str(estimated.quantize(Decimal('0.01'))),"orders_considered":len(delivered),"message":"Tu membresía ya se paga sola." if estimated>=Decimal('79') else "Sigue usando Plus para aumentar tu ahorro."}


@router.get("/experiments/active")
def active_experiments(user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    experiments=db.scalars(select(models.Experiment).where(models.Experiment.status=="running")).all();out=[]
    for exp in experiments:
        if exp.audience_role not in {"all",user.role}: continue
        bucket=int(hashlib.sha256(f"{exp.key}:{user.id}".encode()).hexdigest()[:8],16)%100
        if bucket>=exp.rollout_percent: continue
        assignment=db.scalar(select(models.ExperimentAssignment).where(models.ExperimentAssignment.experiment_id==exp.id,models.ExperimentAssignment.user_id==user.id))
        variants=json.loads(exp.variants_json or '["control","variant"]')
        if not variants: variants=["control"]
        if not assignment:
            variant=variants[int(hashlib.sha256(f"variant:{exp.key}:{user.id}".encode()).hexdigest()[:8],16)%len(variants)]
            assignment=models.ExperimentAssignment(experiment_id=exp.id,user_id=user.id,variant=variant);db.add(assignment);db.commit()
        out.append({"key":exp.key,"variant":assignment.variant,"metric":exp.primary_metric})
    return out


# ---------------------------------------------------------------------------
# Dispatch, ETA, heatmaps, demand and incidents
# ---------------------------------------------------------------------------
@router.get("/orders/{order_id}/eta")
def dynamic_eta(order_id:int,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    order=db.get(models.Order,order_id)
    if not order: raise HTTPException(404,"Pedido no encontrado")
    r=db.get(models.Restaurant,order.restaurant_id)
    if user.role not in {"admin"} and order.user_id!=user.id and order.driver_id!=user.id and not (user.role=="restaurant" and r and r.owner_id==user.id): raise HTTPException(403,"Sin acceso")
    return _order_eta(order,db)


@router.get("/admin/dispatch/{order_id}/candidates")
def dispatch_candidates(order_id:int,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    order=db.get(models.Order,order_id)
    if not order: raise HTTPException(404,"Pedido no encontrado")
    return {"order_id":order.id,"candidates":_dispatch_candidates(order,db)[:20]}


@router.post("/admin/dispatch/{order_id}/auto-assign")
def auto_assign(order_id:int,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    order=db.scalar(select(models.Order).where(models.Order.id==order_id).with_for_update())
    if not order: raise HTTPException(404,"Pedido no encontrado")
    if order.status != "ready" or order.driver_id is not None:
        raise HTTPException(409,"El pedido ya no está disponible para asignación")
    candidate=_claim_dispatch_driver(db,_dispatch_candidates(order,db))
    if not candidate: raise HTTPException(409,"No hay repartidores disponibles")
    order.driver_id=candidate["driver_id"];order.status="assigned"
    db.add(models.OrderEvent(order_id=order.id,status="assigned",actor_user_id=admin.id,metadata_json=json.dumps({"source":"v9_auto_dispatch","score":candidate["score"]})))
    db.add(models.Notification(user_id=order.driver_id,kind="delivery",title="Nueva entrega inteligente",message=f"Tala Eats te asignó el pedido #{order.id}."))
    db.commit();return {"assigned":True,"order_id":order.id,"driver":candidate}


@router.post("/admin/dispatch/{order_id}/reassign")
def reassign(order_id:int,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    order=db.scalar(select(models.Order).where(models.Order.id==order_id).with_for_update())
    if not order: raise HTTPException(404,"Pedido no encontrado")
    if order.status not in {"assigned","ready"}: raise HTTPException(409,"El pedido no admite reasignación en su estado actual")
    old=order.driver_id
    candidate=_claim_dispatch_driver(db,_dispatch_candidates(order,db),exclude=old)
    if not candidate: raise HTTPException(409,"No hay otro repartidor disponible")
    order.driver_id=candidate["driver_id"];order.status="assigned"
    db.add(models.OperationalIncident(order_id=order.id,incident_type="auto_reassignment",severity="medium",title="Reasignación automática",detail=f"Driver anterior {old}",recommended_action="Monitorear nueva recogida",status="resolved",resolved_at=now()))
    db.add(models.OrderEvent(order_id=order.id,status="assigned",actor_user_id=admin.id,metadata_json=json.dumps({"source":"v9_reassign","previous_driver":old})))
    db.commit();return {"order_id":order.id,"previous_driver":old,"driver":candidate}


@router.get("/admin/heatmap")
def heatmap(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db),hours:int=24):
    hours=max(1,min(hours,168));cutoff=now()-timedelta(hours=hours)
    rows=db.execute(
        select(
            models.Order.delivery_lat,models.Order.delivery_lng,models.Order.status,models.Order.total,
            models.Restaurant.lat,models.Restaurant.lng,
        )
        .join(models.Restaurant,models.Restaurant.id==models.Order.restaurant_id)
        .where(models.Order.created_at>=cutoff)
        .order_by(models.Order.created_at.desc()).limit(100000)
    ).all()
    cells=defaultdict(lambda:{"orders":0,"active":0,"gmv":Decimal("0")})
    for delivery_lat,delivery_lng,status,total,restaurant_lat,restaurant_lng in rows:
        lat=delivery_lat if delivery_lat is not None else restaurant_lat
        lng=delivery_lng if delivery_lng is not None else restaurant_lng
        key=(round(lat or 0,2),round(lng or 0,2))
        cells[key]["orders"]+=1;cells[key]["gmv"]+=Decimal(total or 0);cells[key]["active"]+=int(status not in {"delivered","cancelled"})
    online=db.scalar(select(func.count(models.DriverProfile.id)).where(models.DriverProfile.is_online.is_(True))) or 0
    points=[{"lat":lat,"lng":lng,"orders":d["orders"],"active_orders":d["active"],"gmv":str(d["gmv"].quantize(Decimal("0.01"))),"pressure":round(d["active"]/max(1,online),2)} for (lat,lng),d in cells.items()]
    return {"hours":hours,"online_drivers":online,"points":sorted(points,key=lambda x:x["orders"],reverse=True)[:100]}

@router.get("/admin/demand-forecast")
def demand_forecast(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db),hours:int=24):
    hours=max(1,min(hours,72));instant=now();cutoff=instant-timedelta(days=56);recent_cutoff=instant-timedelta(days=7)
    timestamps=db.scalars(select(models.Order.created_at).where(models.Order.created_at>=cutoff).order_by(models.Order.created_at.desc()).limit(100000)).all()
    buckets=defaultdict(list);by_day_hour=defaultdict(int);recent_by_hour=Counter()
    for raw in timestamps:
        t=_aware(raw);by_day_hour[(t.date(),t.hour)]+=1
        if t>=recent_cutoff: recent_by_hour[t.hour]+=1
    for (_,hour),count in by_day_hour.items(): buckets[hour].append(count)
    forecast=[];start=instant.replace(minute=0,second=0,microsecond=0)
    for i in range(hours):
        t=start+timedelta(hours=i);vals=buckets.get(t.hour,[]);avg=sum(vals)/len(vals) if vals else 0;recent=recent_by_hour[t.hour]/7
        predicted=round(avg*.65+recent*.35,1)
        forecast.append({"at":t,"predicted_orders":predicted,"recommended_online_drivers":max(1,math.ceil(predicted/2.2)),"confidence":"medium" if len(vals)>=7 else "low"})
    return {"method":"56d-hourly-moving-average","sample_orders":len(timestamps),"forecast":forecast}

@router.post("/admin/incidents/detect")
def detect_incidents(admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    instant=now();active=db.scalars(select(models.Order).where(models.Order.status.in_(["received","confirmed","preparing","ready","assigned","picked_up","on_the_way"])).order_by(models.Order.updated_at).limit(5000)).all();created=[]
    ids=[o.id for o in active]
    existing=set()
    if ids:
        existing=set(db.execute(select(models.OperationalIncident.order_id,models.OperationalIncident.incident_type).where(models.OperationalIncident.status=="open",models.OperationalIncident.order_id.in_(ids))).all())
    for o in active:
        age=(instant-_aware(o.updated_at)).total_seconds()/60;checks=[]
        if o.status in {"received","confirmed","preparing"} and age>35: checks.append(("restaurant_delay","high","Pedido retrasado en cocina","Contactar restaurante y recalcular ETA"))
        if o.status in {"ready","assigned"} and o.driver_id is None and age>8: checks.append(("no_driver","high","Pedido sin repartidor","Ejecutar auto-dispatch o incentivo"))
        if o.status in {"assigned","picked_up","on_the_way"} and age>25: checks.append(("driver_stalled","medium","Entrega sin movimiento","Contactar/reasignar repartidor"))
        for kind,severity,title,action in checks:
            if (o.id,kind) not in existing:
                row=models.OperationalIncident(order_id=o.id,incident_type=kind,severity=severity,title=title,detail=f"Pedido #{o.id}, {int(age)} min sin cambio",recommended_action=action);db.add(row);created.append(row);existing.add((o.id,kind))
    db.commit();return {"created":len(created),"active_orders":len(active)}

@router.get("/admin/incidents")
def incidents(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db),status:str="open"):
    rows=db.scalars(select(models.OperationalIncident).where(models.OperationalIncident.status==status).order_by(models.OperationalIncident.created_at.desc()).limit(300)).all()
    return [{"id":x.id,"order_id":x.order_id,"type":x.incident_type,"severity":x.severity,"title":x.title,"detail":x.detail,"recommended_action":x.recommended_action,"status":x.status,"created_at":x.created_at} for x in rows]


@router.patch("/admin/incidents/{incident_id}")
def resolve_incident(incident_id:int,payload:schemas.IncidentResolve,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    row=db.get(models.OperationalIncident,incident_id)
    if not row: raise HTTPException(404,"Incidente no encontrado")
    row.status=payload.status;row.resolved_at=now();row.detail=(row.detail+"\n"+payload.note).strip();db.commit();return {"id":row.id,"status":row.status}


@router.post("/admin/incentives",status_code=201)
def create_incentive(payload:schemas.DriverIncentiveCreate,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    row=models.DriverIncentive(zone_name=payload.zone_name,title=payload.title,bonus_per_delivery=payload.bonus_per_delivery,multiplier=payload.multiplier,starts_at=payload.starts_at or now(),ends_at=payload.ends_at,active=True);db.add(row);db.commit();db.refresh(row);return {"id":row.id,"zone_name":row.zone_name,"title":row.title,"bonus_per_delivery":str(row.bonus_per_delivery),"multiplier":str(row.multiplier),"active":row.active}


@router.get("/driver/incentives")
def driver_incentives(user:models.User=Depends(require_role("driver")),db:Session=Depends(get_db)):
    instant=now();rows=db.scalars(select(models.DriverIncentive).where(models.DriverIncentive.active.is_(True),models.DriverIncentive.starts_at<=instant)).all()
    return [{"id":x.id,"zone_name":x.zone_name,"title":x.title,"bonus_per_delivery":str(x.bonus_per_delivery),"multiplier":str(x.multiplier),"ends_at":x.ends_at} for x in rows if x.ends_at is None or _aware(x.ends_at)>=instant]


@router.get("/driver/score")
def driver_score(user:models.User=Depends(require_role("driver")),db:Session=Depends(get_db)):
    p=user.driver_profile
    rows=db.execute(select(models.Order.status,models.Order.created_at,models.Order.delivered_at,models.Order.estimated_minutes).where(models.Order.driver_id==user.id)).all()
    total=len(rows);delivered=[row for row in rows if row.status=="delivered"];cancelled=sum(1 for row in rows if row.status=="cancelled")
    ontime=sum(1 for row in delivered if row.delivered_at and (_aware(row.delivered_at)-_aware(row.created_at)).total_seconds()/60 <= max(60,(row.estimated_minutes or 30)+20))
    punctuality=round(100*ontime/max(1,len(delivered)),1);completion=round(100*len(delivered)/max(1,total),1);score=round(punctuality*.35+completion*.35+float(p.rating if p else 5)/5*30,1)
    return {"score":score,"rating":float(p.rating if p else 5),"punctuality":punctuality,"completion":completion,"deliveries":len(delivered),"cancelled":cancelled,"use":"Calidad y coaching; no genera sanciones automáticas."}

# ---------------------------------------------------------------------------
# Growth: segments, CRM, automation, funnel and experiments
# ---------------------------------------------------------------------------
@router.get("/admin/segments")
def segments(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    users=db.execute(select(models.User.id,models.User.name,models.User.email).where(models.User.role=="customer",models.User.is_active.is_(True)).order_by(models.User.id).limit(5000)).all()
    profiles=_bulk_segments(db,[u.id for u in users]);rows=[{"user_id":u.id,"name":u.name,"email":u.email,**profiles[u.id]} for u in users]
    return {"counts":dict(Counter(x["segment"] for x in rows)),"customers":rows[:500]}

@router.post("/admin/marketing",status_code=201)
def create_marketing(payload:schemas.MarketingAutomationCreate,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    row=models.MarketingAutomation(**payload.model_dump());db.add(row);db.commit();db.refresh(row);return {"id":row.id,"name":row.name,"trigger_type":row.trigger_type,"active":row.active}


@router.get("/admin/marketing")
def marketing(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    rows=db.scalars(select(models.MarketingAutomation).order_by(models.MarketingAutomation.created_at.desc())).all();return [{"id":x.id,"name":x.name,"trigger_type":x.trigger_type,"segment":x.segment,"channel":x.channel,"coupon_code":x.coupon_code,"active":x.active,"last_run_at":x.last_run_at} for x in rows]


@router.post("/admin/marketing/{automation_id}/run")
def run_marketing(automation_id:int,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    automation=db.get(models.MarketingAutomation,automation_id)
    if not automation or not automation.active: raise HTTPException(404,"Automatización no disponible")
    # Bound manual runs so a single HTTP request can never try to process the full
    # customer table. Large campaigns should be executed repeatedly by the worker.
    batch_limit=5000
    users=db.scalars(select(models.User).where(models.User.role=="customer",models.User.is_active.is_(True),models.User.marketing_opt_in.is_(True)).order_by(models.User.id).limit(batch_limit)).all()
    profiles=_bulk_segments(db,[u.id for u in users]);targets=[]
    abandoned={}
    if automation.trigger_type=="cart_abandoned" and users:
        ids=[u.id for u in users];cutoff=now()-timedelta(hours=24)
        rows=db.execute(
            select(
                models.ProductEvent.user_id,
                func.max(case((models.ProductEvent.event_name=="add_to_cart",models.ProductEvent.created_at),else_=None)),
                func.max(case((models.ProductEvent.event_name=="checkout_completed",models.ProductEvent.created_at),else_=None)),
            )
            .where(models.ProductEvent.user_id.in_(ids),models.ProductEvent.created_at>=cutoff,models.ProductEvent.event_name.in_(["add_to_cart","checkout_completed"]))
            .group_by(models.ProductEvent.user_id)
        ).all()
        abandoned={uid:(add_at,checkout_at) for uid,add_at,checkout_at in rows}
    instant=now()
    for u in users:
        profile=profiles[u.id];seg=profile["segment"]
        if automation.segment not in {"all",seg}: continue
        if automation.trigger_type=="inactive_7d" and (profile["days_since_last_order"] is None or profile["days_since_last_order"]<7): continue
        if automation.trigger_type=="inactive_30d" and (profile["days_since_last_order"] is None or profile["days_since_last_order"]<30): continue
        if automation.trigger_type=="vip" and seg!="vip": continue
        if automation.trigger_type=="at_risk" and seg!="at_risk": continue
        if automation.trigger_type=="first_order" and profile["orders"]!=1: continue
        if automation.trigger_type=="birthday" and (not u.birth_date or u.birth_date[5:]!=instant.strftime("%m-%d")): continue
        if automation.trigger_type=="cart_abandoned":
            added,completed=abandoned.get(u.id,(None,None))
            if not added or (completed and _aware(completed)>=_aware(added)): continue
        targets.append(u)
        message=automation.message_template.replace("{coupon}",automation.coupon_code)
        if automation.channel=="email": enqueue_email(db,u.email,automation.name,message)
        else: db.add(models.Notification(user_id=u.id,kind="growth",title=automation.name,message=message))
    automation.last_run_at=instant;db.commit()
    return {"automation_id":automation.id,"targeted_users":len(targets),"channel":automation.channel,"delivery":"in_app" if automation.channel=="in_app" else "queued-email-compatible","batch_limit":batch_limit}

@router.get("/admin/funnel")
def funnel(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db),days:int=30):
    days=max(1,min(days,180));cutoff=now()-timedelta(days=days)
    grouped=db.execute(select(models.ProductEvent.event_name,func.count(models.ProductEvent.id)).where(models.ProductEvent.created_at>=cutoff).group_by(models.ProductEvent.event_name)).all();counts={name:int(count) for name,count in grouped};total=sum(counts.values())
    stages=["app_open","search","restaurant_view","add_to_cart","checkout_started","checkout_completed","order_delivered"]
    data=[];previous=None
    for stage in stages:
        value=counts.get(stage,0);conversion=round(value/previous*100,1) if previous else 100.0;data.append({"stage":stage,"events":value,"step_conversion_percent":conversion});previous=value or previous
    return {"days":days,"total_events":total,"funnel":data}

@router.post("/admin/experiments",status_code=201)
def create_experiment(payload:schemas.ExperimentCreate,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    if db.scalar(select(models.Experiment).where(models.Experiment.key==payload.key)): raise HTTPException(409,"Ya existe ese experimento")
    row=models.Experiment(key=payload.key,name=payload.name,variants_json=json.dumps(payload.variants),audience_role=payload.audience_role,rollout_percent=payload.rollout_percent,status=payload.status,primary_metric=payload.primary_metric);db.add(row);db.commit();db.refresh(row);return {"id":row.id,"key":row.key,"status":row.status}


@router.get("/admin/experiments")
def experiments(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    rows=db.scalars(select(models.Experiment).order_by(models.Experiment.created_at.desc()).limit(200)).all();out=[]
    for exp in rows:
        distribution=db.execute(select(models.ExperimentAssignment.variant,func.count(models.ExperimentAssignment.id)).where(models.ExperimentAssignment.experiment_id==exp.id).group_by(models.ExperimentAssignment.variant)).all();dist={variant:int(count) for variant,count in distribution};metrics={}
        for variant,assigned in dist.items():
            converted=db.scalar(
                select(func.count(func.distinct(models.ExperimentAssignment.user_id)))
                .join(models.ProductEvent,models.ProductEvent.user_id==models.ExperimentAssignment.user_id)
                .where(
                    models.ExperimentAssignment.experiment_id==exp.id,
                    models.ExperimentAssignment.variant==variant,
                    models.ProductEvent.event_name==exp.primary_metric,
                    models.ProductEvent.created_at>=models.ExperimentAssignment.created_at,
                )
            ) or 0
            metrics[variant]={"assigned":assigned,"converted":int(converted),"conversion_rate":round(int(converted)/max(1,assigned)*100,2)}
        out.append({"id":exp.id,"key":exp.key,"name":exp.name,"status":exp.status,"rollout_percent":exp.rollout_percent,"primary_metric":exp.primary_metric,"assignments":dist,"metrics":metrics})
    return out

# ---------------------------------------------------------------------------
# Merchant intelligence, kitchen forecast and inventory/merma
# ---------------------------------------------------------------------------
@router.get("/merchant/intelligence")
def merchant_intelligence(user:models.User=Depends(require_role("restaurant")),db:Session=Depends(get_db)):
    r=_owner_restaurant(db,user)
    orders=db.scalars(select(models.Order).options(selectinload(models.Order.items)).where(models.Order.restaurant_id==r.id).order_by(models.Order.created_at.desc()).limit(1000)).all();delivered=[o for o in orders if o.status=="delivered"]
    item_counter=Counter();revenue=defaultdict(Decimal);hour_counter=Counter();customers=Counter()
    for o in delivered:
        hour_counter[_aware(o.created_at).hour]+=1;customers[o.user_id]+=1
        for item in o.items:
            item_counter[item.name_snapshot]+=item.quantity;revenue[item.name_snapshot]+=Decimal(item.unit_price)*item.quantity
    low=db.scalars(select(models.IngredientStock).where(models.IngredientStock.restaurant_id==r.id,models.IngredientStock.quantity<=models.IngredientStock.reorder_level).order_by(models.IngredientStock.quantity).limit(200)).all()
    return {"restaurant_id":r.id,"orders":len(orders),"delivered":len(delivered),"repeat_customers":sum(1 for n in customers.values() if n>=2),"peak_hours":[{"hour":h,"orders":n} for h,n in hour_counter.most_common(5)],"top_products":[{"name":n,"units":q,"revenue":str(revenue[n].quantize(Decimal('0.01')))} for n,q in item_counter.most_common(10)],"low_ingredients":[{"id":x.id,"name":x.name,"quantity":str(x.quantity),"reorder_level":str(x.reorder_level)} for x in low],"suggestions":["Crea combos con tus productos más vendidos","Activa campaña en horas de baja demanda","Repón ingredientes por debajo del mínimo"]}

@router.get("/merchant/kitchen-forecast")
def kitchen_forecast(user:models.User=Depends(require_role("restaurant")),db:Session=Depends(get_db),hours:int=6):
    r=_owner_restaurant(db,user);hours=max(1,min(hours,24));cutoff=now()-timedelta(days=42)
    timestamps=db.scalars(select(models.Order.created_at).where(models.Order.restaurant_id==r.id,models.Order.created_at>=cutoff).order_by(models.Order.created_at.desc()).limit(50000)).all();aware=[_aware(x) for x in timestamps];b=Counter(x.hour for x in aware);days=max(1,len({x.date() for x in aware}));start=now().replace(minute=0,second=0,microsecond=0);future=[]
    for i in range(hours):
        t=start+timedelta(hours=i);pred=round(b[t.hour]/days,1);future.append({"at":t,"predicted_orders":pred,"recommended_prep_capacity":max(1,math.ceil(pred*1.2)),"status":"high" if pred>=5 else "normal"})
    active=db.scalar(select(func.count(models.Order.id)).where(models.Order.restaurant_id==r.id,models.Order.status.in_(["received","confirmed","preparing"]))) or 0
    return {"active_kitchen_orders":active,"forecast":future,"delay_risk":"high" if active>=8 else "medium" if active>=4 else "low"}

@router.get("/merchant/ingredients")
def ingredients(user:models.User=Depends(require_role("restaurant")),db:Session=Depends(get_db)):
    r=_owner_restaurant(db,user);rows=db.scalars(select(models.IngredientStock).where(models.IngredientStock.restaurant_id==r.id).order_by(models.IngredientStock.name)).all();return [{"id":x.id,"name":x.name,"unit":x.unit,"quantity":str(x.quantity),"reorder_level":str(x.reorder_level),"unit_cost":str(x.unit_cost),"low":x.quantity<=x.reorder_level} for x in rows]


@router.post("/merchant/ingredients",status_code=201)
def create_ingredient(payload:schemas.IngredientCreate,user:models.User=Depends(require_role("restaurant")),db:Session=Depends(get_db)):
    r=_owner_restaurant(db,user);row=models.IngredientStock(restaurant_id=r.id,**payload.model_dump());db.add(row);db.commit();db.refresh(row);return {"id":row.id,"name":row.name,"quantity":str(row.quantity)}


@router.patch("/merchant/ingredients/{ingredient_id}")
def adjust_ingredient(ingredient_id:int,payload:schemas.IngredientAdjust,user:models.User=Depends(require_role("restaurant")),db:Session=Depends(get_db)):
    r=_owner_restaurant(db,user);row=db.get(models.IngredientStock,ingredient_id)
    if not row or row.restaurant_id!=r.id: raise HTTPException(404,"Ingrediente no encontrado")
    row.quantity=max(Decimal("0"),Decimal(row.quantity)+payload.quantity_delta);db.commit();return {"id":row.id,"quantity":str(row.quantity),"reason":payload.reason}


@router.post("/merchant/recipes",status_code=201)
def create_recipe(payload:schemas.RecipeComponentCreate,user:models.User=Depends(require_role("restaurant")),db:Session=Depends(get_db)):
    r=_owner_restaurant(db,user);item=db.get(models.MenuItem,payload.menu_item_id);ingredient=db.get(models.IngredientStock,payload.ingredient_id)
    if not item or item.restaurant_id!=r.id or not ingredient or ingredient.restaurant_id!=r.id: raise HTTPException(404,"Producto o ingrediente no encontrado")
    row=db.scalar(select(models.MenuRecipe).where(models.MenuRecipe.menu_item_id==payload.menu_item_id,models.MenuRecipe.ingredient_id==payload.ingredient_id))
    if row: row.quantity_required=payload.quantity_required
    else: row=models.MenuRecipe(**payload.model_dump());db.add(row)
    db.commit();return {"menu_item_id":row.menu_item_id,"ingredient_id":row.ingredient_id,"quantity_required":str(row.quantity_required)}


@router.post("/merchant/waste",status_code=201)
def waste(payload:schemas.WasteCreate,user:models.User=Depends(require_role("restaurant")),db:Session=Depends(get_db)):
    r=_owner_restaurant(db,user);cost=Decimal("0")
    if payload.ingredient_id:
        ingredient=db.get(models.IngredientStock,payload.ingredient_id)
        if not ingredient or ingredient.restaurant_id!=r.id: raise HTTPException(404,"Ingrediente no encontrado")
        ingredient.quantity=max(Decimal("0"),Decimal(ingredient.quantity)-payload.quantity);cost=Decimal(ingredient.unit_cost)*payload.quantity
    row=models.WasteRecord(restaurant_id=r.id,ingredient_id=payload.ingredient_id,quantity=payload.quantity,reason=payload.reason,estimated_cost=cost);db.add(row);db.commit();return {"id":row.id,"estimated_cost":str(cost.quantize(Decimal('0.01')))}


@router.get("/merchant/upsell/{menu_item_id}")
def upsell(menu_item_id:int,user:models.User=Depends(require_role("restaurant")),db:Session=Depends(get_db)):
    r=_owner_restaurant(db,user);item=db.get(models.MenuItem,menu_item_id)
    if not item or item.restaurant_id!=r.id: raise HTTPException(404,"Producto no encontrado")
    alternatives=db.scalars(select(models.MenuItem).where(models.MenuItem.restaurant_id==r.id,models.MenuItem.id!=item.id,models.MenuItem.is_available.is_(True))).all();alts=sorted(alternatives,key=lambda x:abs(float(x.price)-float(item.price)))[:4]
    return {"base":{"id":item.id,"name":item.name},"suggestions":[{"id":x.id,"name":x.name,"price":float(x.price),"reason":"Complemento/upsell sugerido por rango de precio"} for x in alts]}


# ---------------------------------------------------------------------------
# Corporate, privacy, security and partner API
# ---------------------------------------------------------------------------
@router.post("/admin/corporate",status_code=201)
def create_corporate(payload:schemas.CorporateCreate,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    code=secrets.token_hex(4).upper();row=models.CorporateAccount(name=payload.name,join_code=code,monthly_budget=payload.monthly_budget,cost_center=payload.cost_center);db.add(row);db.commit();db.refresh(row);return {"id":row.id,"name":row.name,"join_code":row.join_code,"monthly_budget":str(row.monthly_budget),"cost_center":row.cost_center}


@router.post("/corporate/join")
def corporate_join(payload:schemas.CorporateJoin,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    account=db.scalar(select(models.CorporateAccount).where(models.CorporateAccount.join_code==payload.join_code.upper(),models.CorporateAccount.active.is_(True)))
    if not account: raise HTTPException(404,"Código empresarial inválido")
    row=db.scalar(select(models.CorporateMember).where(models.CorporateMember.corporate_account_id==account.id,models.CorporateMember.user_id==user.id))
    if not row: row=models.CorporateMember(corporate_account_id=account.id,user_id=user.id,employee_code=payload.employee_code);db.add(row);db.commit()
    return {"joined":True,"company":account.name,"cost_center":account.cost_center,"monthly_budget":str(account.monthly_budget)}


@router.get("/corporate/me")
def corporate_me(user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    memberships=db.scalars(select(models.CorporateMember).where(models.CorporateMember.user_id==user.id,models.CorporateMember.active.is_(True))).all();out=[]
    for m in memberships:
        account=db.get(models.CorporateAccount,m.corporate_account_id)
        if account: out.append({"id":account.id,"membership_id":m.id,"company":account.name,"cost_center":account.cost_center,"employee_code":m.employee_code,"individual_budget":str(m.individual_budget),"monthly_budget":str(account.monthly_budget)})
    return out


@router.post("/privacy",status_code=201)
def privacy(payload:schemas.PrivacyRequestCreate,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    if payload.request_type=="marketing_opt_out": user.marketing_opt_in=False
    result={}
    status="pending"
    if payload.request_type=="export":
        orders=db.scalars(select(models.Order).where(models.Order.user_id==user.id)).all();result={"profile":{"id":user.id,"name":user.name,"email":user.email},"orders":[{"id":o.id,"status":o.status,"total":str(o.total),"created_at":o.created_at.isoformat()} for o in orders],"generated_at":now().isoformat()};status="completed"
    row=models.PrivacyRequest(user_id=user.id,request_type=payload.request_type,status=status,result_json=json.dumps(result,ensure_ascii=False),completed_at=now() if status=="completed" else None);db.add(row);db.commit();db.refresh(row);return {"id":row.id,"type":row.request_type,"status":row.status,"result":result if status=="completed" else None}


@router.get("/security/devices")
def devices(user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    rows=db.scalars(select(models.DeviceSession).where(models.DeviceSession.user_id==user.id).order_by(models.DeviceSession.last_seen_at.desc())).all();return [{"id":x.id,"device":x.device_label,"ip_hint":x.ip_hint,"active":x.active,"created_at":x.created_at,"last_seen_at":x.last_seen_at} for x in rows]


@router.delete("/security/devices/{device_id}",status_code=204)
def revoke_device(device_id:int,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    row=db.get(models.DeviceSession,device_id)
    if not row or row.user_id!=user.id: raise HTTPException(404,"Sesión no encontrada")
    row.active=False;db.commit()


@router.post("/security/2fa/setup")
def two_factor_setup(user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    if user.role not in {"admin", "restaurant", "driver"}:
        raise HTTPException(403, "La verificación 2FA requiere una cuenta autorizada")
    # SECURITY HF1: a stolen session must not reset an existing authenticator.
    # 2FA recovery requires a separate, audited recovery flow.
    if user.two_factor_enabled:
        raise HTTPException(409, "2FA ya está activo. No se puede reiniciar sin recuperación verificada")
    secret = generate_totp_secret()
    user.totp_secret = secret
    user.two_factor_enabled = False
    db.commit()
    label = f"Tala Eats:{user.email}"
    return {"secret": secret,
            "otpauth_uri": f"otpauth://totp/{label}?secret={secret}&issuer=Tala%20Eats&digits=6&period=30",
            "enabled": False}


@router.post("/security/2fa/confirm")
def two_factor_confirm(payload:schemas.TwoFactorVerify,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    if not verify_totp(user.totp_secret,payload.code): raise HTTPException(400,"Código inválido")
    user.two_factor_enabled=True;db.commit();return {"enabled":True}


@router.post("/security/2fa/disable")
def two_factor_disable(payload:schemas.TwoFactorVerify,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    if user.two_factor_enabled and not verify_totp(user.totp_secret,payload.code): raise HTTPException(400,"Código inválido")
    user.two_factor_enabled=False;user.totp_secret="";db.commit();return {"enabled":False}


@router.post("/admin/partner-keys",status_code=201)
def create_partner_key(payload:schemas.PartnerKeyCreate,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    raw="te_live_"+secrets.token_urlsafe(30);digest=hashlib.sha256(raw.encode()).hexdigest();row=models.PartnerApiKey(partner_name=payload.partner_name,key_hash=digest,scopes=payload.scopes);db.add(row);db.commit();return {"id":row.id,"partner":row.partner_name,"api_key":raw,"scopes":row.scopes,"warning":"La clave solo se muestra una vez."}


@router.get("/partner/catalog")
def partner_catalog(x_partner_key:str=Header(default=""),db:Session=Depends(get_db)):
    digest=hashlib.sha256(x_partner_key.encode()).hexdigest();key=db.scalar(select(models.PartnerApiKey).where(models.PartnerApiKey.key_hash==digest,models.PartnerApiKey.active.is_(True)))
    if not key or "catalog:read" not in key.scopes: raise HTTPException(401,"Partner API key inválida")
    key.last_used_at=now();restaurants=db.scalars(select(models.Restaurant).where(models.Restaurant.is_open.is_(True))).all();db.commit();return {"restaurants":[{"id":r.id,"name":r.name,"cuisine":r.cuisine,"branch_code":r.branch_code,"brand_name":r.brand_name} for r in restaurants]}


@router.get("/admin/trust/risk")
def trust_risk(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    users=db.execute(select(models.User.id,models.User.name,models.User.email).where(models.User.role=="customer").order_by(models.User.id).limit(10000)).all();ids=[u.id for u in users]
    if not ids: return []
    order_stats={uid:(int(total or 0),int(cancelled or 0)) for uid,total,cancelled in db.execute(
        select(models.Order.user_id,func.count(models.Order.id),func.sum(case((models.Order.status=="cancelled",1),else_=0))).where(models.Order.user_id.in_(ids)).group_by(models.Order.user_id)
    ).all()}
    refund_stats={uid:int(count or 0) for uid,count in db.execute(
        select(models.Dispute.opened_by_user_id,func.count(models.Dispute.id)).where(models.Dispute.opened_by_user_id.in_(ids),models.Dispute.refund_amount>0).group_by(models.Dispute.opened_by_user_id)
    ).all()}
    rows=[]
    for u in users:
        total,cancelled=order_stats.get(u.id,(0,0));signals=[]
        if refund_stats.get(u.id,0)>=3: signals.append("multiple_refunds")
        if total>=3 and cancelled/max(total,1)>.45: signals.append("high_cancellation_rate")
        if u.email.count("+")>0: signals.append("email_alias")
        if signals: rows.append({"user_id":u.id,"name":u.name,"email":u.email,"signals":signals,"risk_score":min(100,len(signals)*30)})
    return sorted(rows,key=lambda x:x["risk_score"],reverse=True)

@router.get("/admin/system-status")
def system_status(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    checks={"database":"unknown","redis":"not-configured","worker":"not-configured","payments":"configured" if settings.mercado_pago_access_token else "not-configured","websocket":"configured" if settings.redis_url else "local-only","email":"configured" if settings.smtp_host else "not-configured"}
    try: db.execute(text("SELECT 1"));checks["database"]="ok"
    except Exception: checks["database"]="error"
    if settings.redis_url:
        redis_ok, worker_heartbeat = redis_ping()
        checks["redis"] = "ok" if redis_ok else "error"
        checks["worker"] = "ok" if worker_heartbeat else "stale"
    open_incidents=db.scalar(select(func.count(models.OperationalIncident.id)).where(models.OperationalIncident.status=="open")) or 0
    critical={"database","redis"};degraded=any(checks[k]=="error" for k in critical)
    return {"status":"degraded" if degraded else "ok","checks":checks,"open_incidents":open_incidents,"generated_at":now()}

# ---------------------------------------------------------------------------
# V9 markets, branches, batching, missions and effective menu schedules
# ---------------------------------------------------------------------------
@router.get("/markets")
def markets(db:Session=Depends(get_db)):
    rows=db.execute(select(models.Restaurant.market_code,models.Restaurant.brand_name,models.Restaurant.name).where(models.Restaurant.is_open.is_(True))).all();grouped=defaultdict(lambda:{"restaurants":0,"brands":set()})
    for market_code,brand_name,name in rows:
        grouped[market_code]["restaurants"]+=1;grouped[market_code]["brands"].add(brand_name or name)
    return [{"market_code":k,"restaurants":v["restaurants"],"brands":len(v["brands"])} for k,v in grouped.items()]

@router.get("/brands/{brand_name}/best-branch")
def best_branch(brand_name:str,lat:float,lng:float,db:Session=Depends(get_db)):
    rows=db.scalars(select(models.Restaurant).where(models.Restaurant.is_open.is_(True),((models.Restaurant.brand_name==brand_name)|(models.Restaurant.name==brand_name)))).all()
    if not rows: raise HTTPException(404,"Marca no encontrada")
    ids=[r.id for r in rows];active_map={rid:int(count) for rid,count in db.execute(select(models.Order.restaurant_id,func.count(models.Order.id)).where(models.Order.restaurant_id.in_(ids),models.Order.status.in_(["received","confirmed","preparing","ready"])).group_by(models.Order.restaurant_id)).all()}
    ranked=[]
    for r in rows:
        distance=haversine_km(lat,lng,r.lat,r.lng);active=active_map.get(r.id,0);score=distance+active*.6;ranked.append((score,r,distance,active))
    _,r,distance,active=min(ranked,key=lambda x:x[0]);return {"id":r.id,"name":r.name,"brand":r.brand_name or r.name,"branch_code":r.branch_code,"market_code":r.market_code,"distance_km":round(distance,2),"active_kitchen_orders":active,"reason":"Mejor combinación de distancia, disponibilidad y carga"}

@router.get("/restaurants/{restaurant_id}/effective-menu")
def effective_menu(restaurant_id:int,db:Session=Depends(get_db)):
    restaurant=db.get(models.Restaurant,restaurant_id)
    if not restaurant: raise HTTPException(404,"Restaurante no encontrado")
    items=db.scalars(select(models.MenuItem).where(models.MenuItem.restaurant_id==restaurant_id)).all();out=[]
    for item in items:
        available,price=_effective_item(item);out.append({"id":item.id,"name":item.name,"description":item.description,"category":item.category,"base_price":str(item.price),"effective_price":str(price),"available_now":available and item.stock>0,"stock":item.stock,"image_url":item.image_url})
    return {"restaurant_id":restaurant_id,"market_code":restaurant.market_code,"items":out}


@router.get("/admin/dispatch/batches")
def batch_suggestions(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    # V1 production intentionally enforces one active delivery per driver.
    return []


@router.post("/admin/dispatch/batch-assign")
def batch_assign(order_ids:str,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    raise HTTPException(409,"La asignación múltiple está deshabilitada: cada repartidor puede tener solo una entrega activa")


@router.get("/loyalty/missions")
def loyalty_missions(user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    month=now().replace(day=1,hour=0,minute=0,second=0,microsecond=0)
    order_count,restaurant_count=db.execute(select(func.count(models.Order.id),func.count(func.distinct(models.Order.restaurant_id))).where(models.Order.user_id==user.id,models.Order.status=="delivered",models.Order.delivered_at>=month)).one();order_count=int(order_count or 0);restaurant_count=int(restaurant_count or 0)
    missions=[
        {"key":"three_orders","title":"3 pedidos este mes","progress":min(3,order_count),"target":3,"reward_points":100},
        {"key":"two_restaurants","title":"Prueba 2 restaurantes","progress":min(2,restaurant_count),"target":2,"reward_points":80},
    ]
    refs=[f"{m['key']}:{month.strftime('%Y-%m')}" for m in missions]
    claimed=set(db.scalars(select(models.WalletTransaction.reference_id).where(models.WalletTransaction.user_id==user.id,models.WalletTransaction.kind=="mission_reward",models.WalletTransaction.reference_id.in_(refs))).all())
    for m in missions:
        ref=f"{m['key']}:{month.strftime('%Y-%m')}";m["claimed"]=ref in claimed;m["claimable"]=m["progress"]>=m["target"] and not m["claimed"]
    return missions

@router.post("/loyalty/missions/{mission_key}/claim")
def claim_mission(mission_key:str,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    missions={x["key"]:x for x in loyalty_missions(user,db)};m=missions.get(mission_key)
    if not m: raise HTTPException(404,"Misión no encontrada")
    if not m["claimable"]: raise HTTPException(409,"La misión no está lista para canjear")
    acc=db.scalar(select(models.LoyaltyAccount).where(models.LoyaltyAccount.user_id==user.id).with_for_update());acc.points+=m["reward_points"]
    ref=f"{mission_key}:{now().strftime('%Y-%m')}";db.add(models.WalletTransaction(user_id=user.id,kind="mission_reward",amount=Decimal("0"),balance_after=acc.wallet_balance,reference_type="loyalty_mission",reference_id=ref,description=f"+{m['reward_points']} puntos · {m['title']}",idempotency_key=f"mission:{user.id}:{ref}"));db.commit();return {"claimed":True,"points_added":m["reward_points"],"points":acc.points}


# ---------------------------------------------------------------------------
# V9 collaborative group carts, corporate statements and market controls
# ---------------------------------------------------------------------------
@router.post("/groups",status_code=201)
def create_group_cart(payload:schemas.GroupCartCreate,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    restaurant=db.get(models.Restaurant,payload.restaurant_id)
    if not restaurant or not restaurant.is_open: raise HTTPException(404,"Restaurante no disponible")
    for _ in range(10):
        code=secrets.token_hex(3).upper()
        if not db.scalar(select(models.GroupCart.id).where(models.GroupCart.code==code)): break
    row=models.GroupCart(code=code,restaurant_id=restaurant.id,owner_user_id=user.id);db.add(row);db.commit();db.refresh(row)
    return {"id":row.id,"code":row.code,"restaurant_id":row.restaurant_id,"owner_user_id":row.owner_user_id,"locked":row.locked}

@router.get("/groups/{code}")
def group_cart(code:str,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    group=db.scalar(select(models.GroupCart).where(models.GroupCart.code==code.upper()))
    if not group: raise HTTPException(404,"Pedido grupal no encontrado")
    items=db.scalars(select(models.GroupCartItem).where(models.GroupCartItem.group_cart_id==group.id).order_by(models.GroupCartItem.id)).all();participants={x.user_id for x in items}|{group.owner_user_id}
    user_ids=list({x.user_id for x in items});item_ids=list({x.menu_item_id for x in items})
    user_names=dict(db.execute(select(models.User.id,models.User.name).where(models.User.id.in_(user_ids))).all()) if user_ids else {}
    item_names=dict(db.execute(select(models.MenuItem.id,models.MenuItem.name).where(models.MenuItem.id.in_(item_ids))).all()) if item_ids else {}
    return {"code":group.code,"restaurant_id":group.restaurant_id,"owner_user_id":group.owner_user_id,"locked":group.locked,"participants":len(participants),"items":[{"id":x.id,"user_id":x.user_id,"user_name":user_names.get(x.user_id,"Usuario"),"menu_item_id":x.menu_item_id,"name":item_names.get(x.menu_item_id,"Producto"),"quantity":x.quantity,"options":x.options} for x in items]}

@router.post("/groups/{code}/items")
def group_cart_add(code:str,payload:schemas.GroupCartItemWrite,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    group=db.scalar(select(models.GroupCart).where(models.GroupCart.code==code.upper()))
    if not group: raise HTTPException(404,"Pedido grupal no encontrado")
    if group.locked: raise HTTPException(409,"El pedido grupal ya está cerrado")
    item=db.get(models.MenuItem,payload.menu_item_id)
    if not item or item.restaurant_id!=group.restaurant_id or not item.is_available: raise HTTPException(400,"Producto no disponible en este grupo")
    row=db.scalar(select(models.GroupCartItem).where(models.GroupCartItem.group_cart_id==group.id,models.GroupCartItem.user_id==user.id,models.GroupCartItem.menu_item_id==item.id))
    if row: row.quantity=payload.quantity;row.options=payload.options
    else: row=models.GroupCartItem(group_cart_id=group.id,user_id=user.id,menu_item_id=item.id,quantity=payload.quantity,options=payload.options);db.add(row)
    db.commit();return group_cart(code,user,db)

@router.post("/groups/{code}/lock")
def group_cart_lock(code:str,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    group=db.scalar(select(models.GroupCart).where(models.GroupCart.code==code.upper()))
    if not group or group.owner_user_id!=user.id: raise HTTPException(404,"Pedido grupal no encontrado")
    group.locked=True;db.commit();return {"code":group.code,"locked":True}

@router.get("/groups/{code}/checkout-payload")
def group_checkout_payload(code:str,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    group=db.scalar(select(models.GroupCart).where(models.GroupCart.code==code.upper()))
    if not group or group.owner_user_id!=user.id: raise HTTPException(404,"Pedido grupal no encontrado")
    items=db.scalars(select(models.GroupCartItem).where(models.GroupCartItem.group_cart_id==group.id)).all();merged=defaultdict(int)
    for item in items: merged[item.menu_item_id]+=item.quantity
    return {"restaurant_id":group.restaurant_id,"group_code":group.code,"items":[{"menu_item_id":k,"quantity":v,"options":""} for k,v in merged.items()]}

@router.get("/admin/corporate/{account_id}/statement")
def corporate_statement(account_id:int,month:str="",_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    account=db.get(models.CorporateAccount,account_id)
    if not account: raise HTTPException(404,"Cuenta empresarial no encontrada")
    instant=now();start=instant.replace(day=1,hour=0,minute=0,second=0,microsecond=0)
    if month:
        try: start=datetime.strptime(month+"-01","%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError: raise HTTPException(400,"Mes inválido; usa YYYY-MM")
    end=(start+timedelta(days=32)).replace(day=1)
    orders=db.scalars(select(models.Order).where(models.Order.corporate_account_id==account.id,models.Order.created_at>=start,models.Order.created_at<end,models.Order.status!="cancelled")).all();total=sum((Decimal(o.total or 0) for o in orders),Decimal("0"))
    return {"account_id":account.id,"company":account.name,"period":start.strftime("%Y-%m"),"orders":[{"id":o.id,"user_id":o.user_id,"total":str(o.total),"payment_status":o.payment_status,"created_at":o.created_at} for o in orders],"total":str(total.quantize(Decimal("0.01"))),"budget":str(account.monthly_budget)}

@router.post("/admin/corporate/{account_id}/settle")
def settle_corporate(account_id:int,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    account=db.get(models.CorporateAccount,account_id)
    if not account: raise HTTPException(404,"Cuenta empresarial no encontrada")
    orders=db.scalars(select(models.Order).where(models.Order.corporate_account_id==account.id,models.Order.payment_status=="corporate_pending",models.Order.status=="delivered")).all();total=Decimal("0")
    for order in orders: order.payment_status="paid";total+=Decimal(order.total or 0)
    db.add(models.AuditEvent(user_id=admin.id,action="v9.corporate.settle",entity_type="corporate_account",entity_id=str(account.id),detail=f"{len(orders)} orders · {total}"));db.commit();return {"settled_orders":len(orders),"total":str(total.quantize(Decimal("0.01")))}

@router.patch("/admin/restaurants/{restaurant_id}/market")
def assign_market(restaurant_id:int,market_code:str,brand_name:str="",branch_code:str="MAIN",_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    restaurant=db.get(models.Restaurant,restaurant_id)
    if not restaurant: raise HTTPException(404,"Restaurante no encontrado")
    restaurant.market_code=market_code.strip().upper()[:40];restaurant.brand_name=brand_name.strip()[:150];restaurant.branch_code=branch_code.strip().upper()[:40];db.commit();return {"id":restaurant.id,"market_code":restaurant.market_code,"brand_name":restaurant.brand_name,"branch_code":restaurant.branch_code}
