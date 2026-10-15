from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_role
from ..geo import haversine_km
from ..monetization import DEFAULTS, get_decimal_setting, money, commercial_value, commercial_v152_active, commercial_v162_active
from ..wallet import credit_wallet, get_loyalty_account
from ..feature_flags import enabled as feature_enabled

router = APIRouter(prefix="/api/v1/operations", tags=["operations-v6"])
ACTIVE_STATUSES = {"received", "confirmed", "preparing", "ready", "assigned", "picked_up", "on_the_way"}
SIM_STEPS = ["customer_order", "restaurant_confirm", "preparing", "ready", "driver_assigned", "picked_up", "on_the_way", "delivered", "settled"]


def now():
    return datetime.now(timezone.utc)


def _block_unverified_legacy_finance() -> None:
    """No self-attested bank-paid or cash-settled status in production."""
    if settings.is_production:
        raise HTTPException(
            409,
            "Operacion financiera legacy no conciliada, bloqueada en produccion",
        )


def audit(db: Session, user_id: int | None, action: str, entity_type: str = "", entity_id: str = "", detail: str = ""):
    db.add(models.AuditEvent(user_id=user_id, action=action, entity_type=entity_type, entity_id=entity_id, detail=detail[:5000]))


def owner_restaurant(db: Session, user: models.User) -> models.Restaurant:
    if user.role == "admin":
        row = db.scalar(select(models.Restaurant).order_by(models.Restaurant.id))
    else:
        row = db.scalar(select(models.Restaurant).where(models.Restaurant.owner_id == user.id))
    if not row:
        raise HTTPException(404, "No hay restaurante asociado a esta cuenta")
    return row


# ---------------------------------------------------------------------------
# Onboarding & verification
# ---------------------------------------------------------------------------
@router.post("/onboarding", response_model=schemas.OnboardingPublic, status_code=201)
def create_onboarding(payload: schemas.OnboardingCreate, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if settings.merchant_managed_delivery and payload.entity_type == "driver":
        raise HTTPException(410, "El registro de repartidores no está activo en Tala Eats V1")
    existing = db.scalar(select(models.OnboardingApplication).where(
        models.OnboardingApplication.user_id == user.id,
        models.OnboardingApplication.entity_type == payload.entity_type,
        models.OnboardingApplication.status.in_(["pending", "needs_info", "approved"]),
    ).order_by(models.OnboardingApplication.created_at.desc()))
    if existing and existing.status == "approved":
        raise HTTPException(409, "Ya existe una solicitud aprobada")
    if existing and existing.status in {"pending", "needs_info"}:
        row = existing
        for key, value in payload.model_dump(exclude={"documents"}).items():
            setattr(row, key, value)
        row.documents_json = json.dumps(payload.documents, ensure_ascii=False)
        row.status = "pending"
    else:
        row = models.OnboardingApplication(
            user_id=user.id,
            **payload.model_dump(exclude={"documents"}),
            documents_json=json.dumps(payload.documents, ensure_ascii=False),
        )
        db.add(row)
    audit(db, user.id, "onboarding.submit", payload.entity_type, "", payload.business_name)
    db.commit(); db.refresh(row)
    return row


@router.get("/onboarding/mine", response_model=list[schemas.OnboardingPublic])
def my_onboarding(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.scalars(select(models.OnboardingApplication).where(models.OnboardingApplication.user_id == user.id).order_by(models.OnboardingApplication.created_at.desc()).limit(200)).all()


@router.get("/admin/onboarding", response_model=list[schemas.OnboardingPublic])
def admin_onboarding(_: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    return db.scalars(select(models.OnboardingApplication).order_by(models.OnboardingApplication.created_at.desc()).limit(500)).all()


@router.patch("/admin/onboarding/{application_id}", response_model=schemas.OnboardingPublic)
def decide_onboarding(application_id: int, payload: schemas.OnboardingDecision, admin: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    row = db.get(models.OnboardingApplication, application_id)
    if not row:
        raise HTTPException(404, "Solicitud no encontrada")
    row.status = payload.status; row.notes = payload.notes
    user = db.get(models.User, row.user_id)
    if payload.status == "approved" and user:
        if row.entity_type == "driver" and settings.merchant_managed_delivery:
            raise HTTPException(409, "Tala Eats Driver está desactivado en V1; no se pueden aprobar repartidores")
        if row.entity_type == "driver":
            user.role = "driver"
            profile = db.scalar(select(models.DriverProfile).where(models.DriverProfile.user_id == user.id))
            if not profile:
                profile = models.DriverProfile(user_id=user.id, vehicle=row.vehicle or "Motocicleta", is_verified=True)
                db.add(profile)
            else:
                profile.vehicle = row.vehicle or profile.vehicle; profile.is_verified = True
        elif row.entity_type == "restaurant":
            user.role = "restaurant"
            restaurant = db.scalar(select(models.Restaurant).where(models.Restaurant.owner_id == user.id))
            if not restaurant:
                restaurant = models.Restaurant(
                    name=row.business_name or f"Restaurante de {user.name}",
                    description="Restaurante en incorporación a Tala Eats",
                    owner_id=user.id,
                    tax_id=row.tax_id,
                    payout_account_ref=row.payout_account_ref,
                    verification_status="verified",
                    onboarding_status="approved",
                    is_open=False,
                )
                db.add(restaurant)
            else:
                restaurant.onboarding_status="approved"; restaurant.verification_status="verified"
                restaurant.tax_id=row.tax_id or restaurant.tax_id; restaurant.payout_account_ref=row.payout_account_ref or restaurant.payout_account_ref
    audit(db, admin.id, "onboarding.decision", row.entity_type, str(row.id), f"{payload.status}: {payload.notes}")
    db.commit(); db.refresh(row)
    return row


# ---------------------------------------------------------------------------
# Service zones & coverage
# ---------------------------------------------------------------------------
@router.get("/zones", response_model=list[schemas.ServiceZonePublic])
def list_zones(db: Session = Depends(get_db)):
    return db.scalars(select(models.ServiceZone).where(models.ServiceZone.active.is_(True)).order_by(models.ServiceZone.name)).all()


@router.post("/admin/zones", response_model=schemas.ServiceZonePublic, status_code=201)
def create_zone(payload: schemas.ServiceZoneCreate, admin: models.User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    if db.scalar(select(models.ServiceZone).where(models.ServiceZone.name == payload.name)):
        raise HTTPException(409, "Ya existe una zona con ese nombre")
    row = models.ServiceZone(**payload.model_dump()); db.add(row)
    audit(db, admin.id, "zone.create", "service_zone", "", payload.name)
    db.commit(); db.refresh(row); return row


@router.get("/coverage")
def coverage(lat: float, lng: float, db: Session = Depends(get_db)):
    zones = db.scalars(select(models.ServiceZone).where(models.ServiceZone.active.is_(True))).all()
    matches=[]
    for z in zones:
        distance=haversine_km(lat,lng,z.center_lat,z.center_lng)
        if distance <= z.radius_km:
            matches.append({"id":z.id,"name":z.name,"distance_to_center_km":round(distance,2),"surcharge":str(z.surcharge),"min_order":str(z.min_order)})
    return {"covered":bool(matches),"zones":matches}


# ---------------------------------------------------------------------------
# Commerce configuration, flags and settings
# ---------------------------------------------------------------------------
@router.patch("/admin/restaurants/{restaurant_id}/commercial")
def update_commercial_config(restaurant_id:int, payload:schemas.CommercialConfigUpdate, admin:models.User=Depends(require_role("admin")), db:Session=Depends(get_db)):
    row=db.get(models.Restaurant,restaurant_id)
    if not row: raise HTTPException(404,"Restaurante no encontrado")
    for key,value in payload.model_dump(exclude_unset=True).items():
        setattr(row,key,value)
    audit(db,admin.id,"restaurant.commercial.update","restaurant",str(row.id),json.dumps(payload.model_dump(exclude_unset=True),default=str))
    db.commit();db.refresh(row)
    return {"id":row.id,"commercial_plan":row.commercial_plan,"commission_rate":str(row.commission_rate),"service_fee_rate":str(row.service_fee_rate),"service_fee_fixed":str(row.service_fee_fixed),"payout_account_ref":row.payout_account_ref}



@router.get("/admin/commercial-pricing")
def commercial_pricing_admin(_: models.User=Depends(require_role("admin")), db:Session=Depends(get_db)):
    """Read-only effective policy. Restaurant columns are retained for legacy rollback."""
    enabled = commercial_v152_active()
    policy162 = commercial_v162_active()
    return {
        "policy_version": "1.6.2" if policy162 else "1.5.2" if enabled else "legacy",
        "enabled": enabled,
        "restaurant_commission_rate": str(commercial_value(db, 'commercial_v152.restaurant_commission_rate', Decimal('0.50'))) if enabled else None,
        "service_fee_rate": str(commercial_value(db, 'commercial_v162.service_fee_rate' if policy162 else 'commercial_v152.service_fee_rate', Decimal('0.25'))) if enabled else None,
        "service_fee_cap": str(commercial_value(db, 'commercial_v162.service_fee_cap', Decimal('10000'))) if policy162 else None,
        "base_delivery_fee": str(commercial_value(db, 'commercial_v162.base_delivery_fee' if policy162 else 'commercial_v152.base_delivery_fee', Decimal('10000'))) if enabled else None,
        "delivery_included_km": str(commercial_value(db, 'commercial_v162.included_km', Decimal('100'))) if policy162 else None,
        "delivery_additional_per_km": str(commercial_value(db, 'commercial_v162.additional_per_km', Decimal('1000'))) if policy162 else None,
        "base_driver_pay": str(commercial_value(db, 'commercial_v152.base_driver_pay', Decimal('10000'))) if enabled else None,
        "driver_additional_per_km": str(commercial_value(db, 'commercial_v162.driver_additional_per_km', Decimal('100'))) if policy162 else None,
        "driver_included_km": str(commercial_value(db, 'commercial_v162.included_km', Decimal('100'))) if policy162 else None,
        "tips_fee_rate": "0",
        "service_fee_basis": "subtotal_minus_discount_without_shipping_or_tip",
        "legacy_restaurant_rates_retained_for_rollback": True,
    }

@router.get("/admin/settings", response_model=list[schemas.SettingPublic])
def settings_list(_:models.User=Depends(require_role("admin")), db:Session=Depends(get_db)):
    return db.scalars(select(models.SystemSetting).order_by(models.SystemSetting.key)).all()


@router.put("/admin/settings", response_model=schemas.SettingPublic)
def setting_write(payload:schemas.SettingWrite, admin:models.User=Depends(require_role("admin")), db:Session=Depends(get_db)):
    row=db.scalar(select(models.SystemSetting).where(models.SystemSetting.key==payload.key))
    if row:
        for key,value in payload.model_dump().items(): setattr(row,key,value)
        row.updated_by_user_id=admin.id
    else:
        row=models.SystemSetting(**payload.model_dump(),updated_by_user_id=admin.id);db.add(row)
    audit(db,admin.id,"setting.write","setting",payload.key,payload.value)
    db.commit();db.refresh(row);return row


@router.get("/flags", response_model=list[schemas.FeatureFlagPublic])
def flags(user:models.User=Depends(get_current_user), db:Session=Depends(get_db)):
    rows=db.scalars(select(models.FeatureFlag).where(models.FeatureFlag.enabled.is_(True))).all()
    return [x for x in rows if feature_enabled(db, x.key, user_id=user.id, role=user.role, default=False)]


@router.get("/admin/flags", response_model=list[schemas.FeatureFlagPublic])
def admin_flags(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    return db.scalars(select(models.FeatureFlag).order_by(models.FeatureFlag.key)).all()


@router.put("/admin/flags", response_model=schemas.FeatureFlagPublic)
def write_flag(payload:schemas.FeatureFlagWrite,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    row=db.scalar(select(models.FeatureFlag).where(models.FeatureFlag.key==payload.key))
    if row:
        for key,value in payload.model_dump().items(): setattr(row,key,value)
    else:
        row=models.FeatureFlag(**payload.model_dump());db.add(row)
    audit(db,admin.id,"feature_flag.write","feature_flag",payload.key,str(payload.enabled))
    db.commit();db.refresh(row);return row


# ---------------------------------------------------------------------------
# Command Center, finance, SLA & ledger
# ---------------------------------------------------------------------------
@router.get("/admin/command-center")
def command_center(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    instant=now(); today=instant.replace(hour=0,minute=0,second=0,microsecond=0)
    delayed_cutoff = instant - timedelta(minutes=20)
    active_count = db.scalar(select(func.count(models.Order.id)).where(models.Order.status.in_(ACTIVE_STATUSES))) or 0
    unassigned_ready = db.scalar(select(func.count(models.Order.id)).where(models.Order.status=="ready", models.Order.driver_id.is_(None))) or 0
    delayed_count = db.scalar(select(func.count(models.Order.id)).where(models.Order.status.in_(ACTIVE_STATUSES), models.Order.updated_at < delayed_cutoff)) or 0
    delayed = db.execute(
        select(models.Order.id, models.Order.status, models.Order.updated_at)
        .where(models.Order.status.in_(ACTIVE_STATUSES), models.Order.updated_at < delayed_cutoff)
        .order_by(models.Order.updated_at)
        .limit(20)
    ).all()
    delivered_count, gmv, revenue, margin = db.execute(
        select(
            func.count(models.Order.id),
            func.coalesce(func.sum(models.Order.total), 0),
            func.coalesce(func.sum(models.Order.platform_revenue), 0),
            func.coalesce(func.sum(models.Order.contribution_margin), 0),
        ).where(models.Order.status=="delivered", models.Order.updated_at>=today)
    ).one()
    return {
        "timestamp":instant,
        "live":{
            "active_orders":int(active_count),
            "open_restaurants":db.scalar(select(func.count(models.Restaurant.id)).where(models.Restaurant.is_open.is_(True))) or 0,
            "online_drivers":db.scalar(select(func.count(models.DriverProfile.id)).where(models.DriverProfile.is_online.is_(True))) or 0,
            "delayed_orders":int(delayed_count),
            "unassigned_ready":int(unassigned_ready),
            "open_incidents":db.scalar(select(func.count(models.Dispute.id)).where(models.Dispute.status=="open")) or 0,
            "open_support":db.scalar(select(func.count(models.SupportTicket.id)).where(models.SupportTicket.status=="open")) or 0,
        },
        "today":{"gmv":str(money(Decimal(gmv or 0))),"platform_revenue":str(money(Decimal(revenue or 0))),"contribution_margin":str(money(Decimal(margin or 0))),"delivered_orders":int(delivered_count or 0)},
        "alerts":[{"order_id":order_id,"status":status,"minutes_since_update":int((instant-(updated_at if updated_at.tzinfo else updated_at.replace(tzinfo=timezone.utc))).total_seconds()/60)} for order_id,status,updated_at in delayed if updated_at],
    }


@router.get("/admin/finance/summary")
def finance_summary(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    columns = [
        models.Order.total, models.Order.subtotal, models.Order.platform_commission, models.Order.service_fee,
        models.Order.delivery_fee, models.Order.driver_earning, models.Order.restaurant_payout,
        models.Order.payment_processing_fee, models.Order.promotion_subsidy, models.Order.platform_revenue,
        models.Order.contribution_margin,
    ]
    row = db.execute(
        select(func.count(models.Order.id), *[func.coalesce(func.sum(column), 0) for column in columns])
        .where(models.Order.status=="delivered")
    ).one()
    orders, *totals = row
    totals = [money(Decimal(value or 0)) for value in totals]
    return {
        "gmv":str(totals[0]),"food_subtotal":str(totals[1]),"platform_commission":str(totals[2]),
        "service_fees":str(totals[3]),"delivery_fees":str(totals[4]),"driver_payables":str(totals[5]),
        "restaurant_payables":str(totals[6]),"processing_cost":str(totals[7]),
        "promotion_subsidy":str(totals[8]),"platform_revenue":str(totals[9]),"contribution_margin":str(totals[10]),
        "orders":int(orders or 0),
    }


@router.get("/admin/finance/orders/{order_id}")
def order_economics(order_id:int,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    o=db.get(models.Order,order_id)
    if not o:raise HTTPException(404,"Pedido no encontrado")
    return {"order_id":o.id,"subtotal":str(o.subtotal),"discount":str(o.discount),"service_fee":str(o.service_fee),"delivery_fee":str(o.delivery_fee),"tip":str(o.tip),"total":str(o.total),"restaurant_payout":str(o.restaurant_payout),"driver_earning":str(o.driver_earning),"commission":str(o.platform_commission),"processing_fee":str(o.payment_processing_fee),"promotion_subsidy":str(o.promotion_subsidy),"platform_revenue":str(o.platform_revenue),"contribution_margin":str(o.contribution_margin),"cash_collected":str(o.cash_collected),"cancellation_fee":str(o.cancellation_fee)}


@router.get("/admin/ledger")
def ledger(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db),limit:int=200):
    rows=db.scalars(select(models.FinancialLedgerEntry).order_by(models.FinancialLedgerEntry.created_at.desc()).limit(min(max(limit,1),500))).all()
    return [{"id":x.id,"order_id":x.order_id,"restaurant_id":x.restaurant_id,"user_id":x.user_id,"account":x.account,"direction":x.direction,"amount":str(x.amount),"kind":x.kind,"description":x.description,"created_at":x.created_at} for x in rows]


@router.get("/admin/sla")
def sla(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    orders=db.scalars(select(models.Order).where(models.Order.status=="delivered").order_by(models.Order.created_at.desc()).limit(500)).all()
    prep=[];delivery=[];end_to_end=[]
    for o in orders:
        def aware(d): return d if not d or d.tzinfo else d.replace(tzinfo=timezone.utc)
        if o.ready_at and o.accepted_at: prep.append((aware(o.ready_at)-aware(o.accepted_at)).total_seconds()/60)
        if o.delivered_at and o.picked_up_at: delivery.append((aware(o.delivered_at)-aware(o.picked_up_at)).total_seconds()/60)
        if o.delivered_at: end_to_end.append((aware(o.delivered_at)-aware(o.created_at)).total_seconds()/60)
    avg=lambda values: round(sum(values)/len(values),1) if values else 0
    return {"sample":len(orders),"avg_prep_minutes":avg(prep),"avg_delivery_minutes":avg(delivery),"avg_end_to_end_minutes":avg(end_to_end),"target":{"accept":5,"prep":30,"delivery":35,"end_to_end":60}}


# ---------------------------------------------------------------------------
# Payouts and cash reconciliation
# ---------------------------------------------------------------------------
@router.get("/admin/payouts",response_model=list[schemas.PayoutPublic])
def payouts(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    return db.scalars(select(models.Payout).order_by(models.Payout.created_at.desc()).limit(300)).all()


@router.post("/admin/payouts/run")
def generate_payouts(admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db),days:int=7):
    _block_unverified_legacy_finance()
    end=now();start=end-timedelta(days=max(1,min(days,31)))
    restaurants={int(payee_id):Decimal(amount or 0) for payee_id,amount in db.execute(
        select(models.Order.restaurant_id, func.coalesce(func.sum(models.Order.restaurant_payout), 0))
        .where(models.Order.status=="delivered",models.Order.delivered_at>=start,models.Order.delivered_at<=end)
        .group_by(models.Order.restaurant_id)
    ).all()}
    drivers={int(payee_id):Decimal(amount or 0) for payee_id,amount in db.execute(
        select(models.Order.driver_id, func.coalesce(func.sum(models.Order.driver_earning + models.Order.tip), 0))
        .where(models.Order.status=="delivered",models.Order.delivered_at>=start,models.Order.delivered_at<=end,models.Order.driver_id.is_not(None))
        .group_by(models.Order.driver_id)
    ).all() if payee_id is not None}
    created=[]
    for typ,values in (("restaurant",restaurants),("driver",drivers)):
        for payee_id,amount in values.items():
            if amount<=0:continue
            exists=db.scalar(select(models.Payout.id).where(models.Payout.payee_type==typ,models.Payout.payee_id==payee_id,models.Payout.period_start==start,models.Payout.period_end==end))
            if exists:continue
            row=models.Payout(payee_type=typ,payee_id=payee_id,amount=money(amount),period_start=start,period_end=end,status="pending")
            db.add(row);created.append(row)
    audit(db,admin.id,"payout.run","payout_batch","",f"period={start.isoformat()}..{end.isoformat()} created={len(created)}")
    db.commit()
    return {"period_start":start,"period_end":end,"created":len(created),"transfer_provider":"manual/provider-required","message":"Los saldos quedan conciliados y pendientes. La transferencia bancaria real requiere proveedor de payouts configurado."}


@router.post("/admin/payouts/{payout_id}/mark-paid",response_model=schemas.PayoutPublic)
def mark_payout_paid(payout_id:int,provider_ref:str,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    _block_unverified_legacy_finance()
    row=db.get(models.Payout,payout_id)
    if not row:raise HTTPException(404,"Payout no encontrado")
    row.status="paid";row.provider_ref=provider_ref[:180];row.paid_at=now()
    audit(db,admin.id,"payout.mark_paid","payout",str(row.id),row.provider_ref)
    db.commit();db.refresh(row);return row


@router.get("/admin/cash-settlements",response_model=list[schemas.CashSettlementPublic])
def cash_settlements(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    return db.scalars(select(models.CashSettlement).order_by(models.CashSettlement.created_at.desc()).limit(300)).all()


@router.post("/admin/cash-settlements/run")
def generate_cash_settlements(admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db),days:int=1):
    _block_unverified_legacy_finance()
    end=now();start=end-timedelta(days=max(1,min(days,31)))
    grouped={}
    for driver_id,cash,earning in db.execute(
        select(
            models.Order.driver_id,
            func.coalesce(func.sum(func.coalesce(func.nullif(models.Order.cash_collected, 0), models.Order.total)), 0),
            func.coalesce(func.sum(models.Order.driver_earning + models.Order.tip), 0),
        )
        .where(models.Order.status=="delivered",models.Order.payment_method=="cash",models.Order.delivered_at>=start,models.Order.delivered_at<=end,models.Order.driver_id.is_not(None))
        .group_by(models.Order.driver_id)
    ).all():
        if driver_id is not None:
            grouped[int(driver_id)]={"cash":Decimal(cash or 0),"earning":Decimal(earning or 0)}
    created=[]
    label=f"{start.date()} — {end.date()}"
    for driver_id,g in grouped.items():
        due=max(Decimal('0'),g["cash"]-g["earning"])
        row=models.CashSettlement(driver_id=driver_id,period_label=label,cash_collected=money(g["cash"]),driver_earnings=money(g["earning"]),amount_due_platform=money(due))
        db.add(row);created.append(row)
    audit(db,admin.id,"cash.settlement.run","cash_batch","",f"created={len(created)}")
    db.commit();return {"created":len(created),"period":label}


@router.patch("/admin/cash-settlements/{settlement_id}",response_model=schemas.CashSettlementPublic)
def settle_cash(settlement_id:int,notes:str="",admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    _block_unverified_legacy_finance()
    row=db.get(models.CashSettlement,settlement_id)
    if not row:raise HTTPException(404,"Liquidación no encontrada")
    row.status="settled";row.notes=notes[:400];row.settled_at=now();audit(db,admin.id,"cash.settlement.complete","cash_settlement",str(row.id),row.notes)
    db.commit();db.refresh(row);return row


# ---------------------------------------------------------------------------
# Disputes, Plus, advertising and referrals
# ---------------------------------------------------------------------------
@router.post("/disputes",response_model=schemas.DisputePublic,status_code=201)
def create_dispute(payload:schemas.DisputeCreate,user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    order=db.get(models.Order,payload.order_id)
    if not order:raise HTTPException(404,"Pedido no encontrado")
    restaurant=db.get(models.Restaurant,order.restaurant_id)
    allowed=user.role=="admin" or order.user_id==user.id or order.driver_id==user.id or (user.role=="restaurant" and restaurant and restaurant.owner_id==user.id)
    if not allowed:raise HTTPException(403,"Sin acceso a ese pedido")
    row=models.Dispute(opened_by_user_id=user.id,**payload.model_dump());db.add(row);audit(db,user.id,"dispute.open","order",str(order.id),payload.category)
    db.commit();db.refresh(row);return row


@router.get("/disputes",response_model=list[schemas.DisputePublic])
def disputes(user:models.User=Depends(get_current_user),db:Session=Depends(get_db)):
    stmt=select(models.Dispute).order_by(models.Dispute.created_at.desc())
    if user.role!="admin":stmt=stmt.where(models.Dispute.opened_by_user_id==user.id)
    return db.scalars(stmt.limit(300)).all()


@router.patch("/admin/disputes/{dispute_id}",response_model=schemas.DisputePublic)
def resolve_dispute(dispute_id:int,payload:schemas.DisputeResolve,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    row=db.get(models.Dispute,dispute_id)
    if not row:raise HTTPException(404,"Disputa no encontrada")
    order=db.get(models.Order,row.order_id)
    if payload.refund_amount>0:
        if not order or payload.refund_amount>order.total:raise HTTPException(400,"Reembolso inválido")
        account=get_loyalty_account(db,order.user_id,lock=True)
        credit_wallet(db,order.user_id,payload.refund_amount,kind="dispute_refund",reference_type="dispute",reference_id=str(row.id),description=f"Resolución disputa #{row.id}",idempotency_key=f"dispute:{row.id}:refund",account=account)
    row.status=payload.status;row.resolution=payload.resolution;row.refund_amount=payload.refund_amount;row.assigned_to_user_id=admin.id;row.resolved_at=now() if payload.status in {"resolved","rejected"} else None
    audit(db,admin.id,"dispute.resolve","dispute",str(row.id),payload.resolution)
    db.commit();db.refresh(row);return row


@router.post("/plus/subscribe")
def plus_subscribe(payload:schemas.PlusSubscribeRequest,user:models.User=Depends(require_role("customer")),db:Session=Depends(get_db)):
    account=get_loyalty_account(db,user.id,lock=True);account.plus_member=True
    active=db.scalar(select(models.PlusSubscription).where(models.PlusSubscription.user_id==user.id,models.PlusSubscription.status=="active"))
    price=get_decimal_setting(db,"plus_monthly_price",DEFAULTS["plus_monthly_price"])
    if active:active.plan=payload.plan;active.price_monthly=price;row=active
    else:row=models.PlusSubscription(user_id=user.id,plan=payload.plan,price_monthly=price,renews_at=now()+timedelta(days=30));db.add(row)
    db.commit();return {"active":True,"plan":row.plan,"price_monthly":str(row.price_monthly),"renews_at":row.renews_at}


@router.get("/owner/campaigns",response_model=list[schemas.SponsoredCampaignPublic])
def owner_campaigns(user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    r=owner_restaurant(db,user);return db.scalars(select(models.SponsoredCampaign).where(models.SponsoredCampaign.restaurant_id==r.id).order_by(models.SponsoredCampaign.created_at.desc()).limit(200)).all()


@router.post("/owner/campaigns",response_model=schemas.SponsoredCampaignPublic,status_code=201)
def create_campaign(payload:schemas.SponsoredCampaignCreate,user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    r=owner_restaurant(db,user)
    if user.role!="admin" and payload.restaurant_id!=r.id:raise HTTPException(403,"Solo puedes anunciar tu restaurante")
    row=models.SponsoredCampaign(**payload.model_dump());db.add(row);audit(db,user.id,"ads.campaign.create","restaurant",str(payload.restaurant_id),payload.name);db.commit();db.refresh(row);return row


@router.post("/referrals/apply")
def apply_referral(code:str,user:models.User=Depends(require_role("customer")),db:Session=Depends(get_db)):
    if db.scalar(select(models.ReferralConversion).where(models.ReferralConversion.referred_user_id==user.id)):
        raise HTTPException(409,"Ya aplicaste un referido")
    ref_account=db.scalar(select(models.LoyaltyAccount).where(models.LoyaltyAccount.referral_code==code.upper().strip()))
    if not ref_account or ref_account.user_id==user.id:raise HTTPException(400,"Código de referido inválido")
    reward=get_decimal_setting(db,"referral_reward",DEFAULTS["referral_reward"])
    row=models.ReferralConversion(referrer_user_id=ref_account.user_id,referred_user_id=user.id,referral_code=code.upper().strip(),reward_amount=reward)
    db.add(row);db.commit();return {"status":"pending","message":"El beneficio se libera después del primer pedido entregado válido.","reward":str(reward)}


# ---------------------------------------------------------------------------
# Role-specific finance views
# ---------------------------------------------------------------------------
@router.get("/owner/finance")
def owner_finance(user:models.User=Depends(require_role("restaurant","admin")),db:Session=Depends(get_db)):
    r=owner_restaurant(db,user)
    order_count,gross,commission,payable=db.execute(
        select(func.count(models.Order.id),func.coalesce(func.sum(models.Order.subtotal),0),func.coalesce(func.sum(models.Order.platform_commission),0),func.coalesce(func.sum(models.Order.restaurant_payout),0))
        .where(models.Order.restaurant_id==r.id,models.Order.status=="delivered")
    ).one()
    payouts=db.scalars(select(models.Payout).where(models.Payout.payee_type=="restaurant",models.Payout.payee_id==r.id).order_by(models.Payout.created_at.desc()).limit(20)).all()
    return {"restaurant_id":r.id,"commercial_plan":r.commercial_plan,"commission_rate":str(r.commission_rate),"gross_food_sales":str(money(Decimal(gross or 0))),"commission":str(money(Decimal(commission or 0))),"net_payable":str(money(Decimal(payable or 0))),"orders":int(order_count or 0),"payouts":[{"id":p.id,"amount":str(p.amount),"status":p.status,"period_start":p.period_start,"period_end":p.period_end} for p in payouts]}


@router.get("/driver/finance")
def driver_finance(user:models.User=Depends(require_role("driver")),db:Session=Depends(get_db)):
    deliveries,earnings,cash=db.execute(
        select(
            func.count(models.Order.id),
            func.coalesce(func.sum(models.Order.driver_earning + models.Order.tip),0),
            func.coalesce(func.sum(func.coalesce(func.nullif(models.Order.cash_collected,0),0)).filter(models.Order.payment_method=="cash"),0),
        ).where(models.Order.driver_id==user.id,models.Order.status=="delivered")
    ).one()
    payouts=db.scalars(select(models.Payout).where(models.Payout.payee_type=="driver",models.Payout.payee_id==user.id).order_by(models.Payout.created_at.desc()).limit(20)).all()
    return {"driver_id":user.id,"deliveries":int(deliveries or 0),"gross_earnings":str(money(Decimal(earnings or 0))),"cash_collected":str(money(Decimal(cash or 0))),"payouts":[{"id":p.id,"amount":str(p.amount),"status":p.status} for p in payouts]}


# ---------------------------------------------------------------------------
# Simulation / QA mode
# ---------------------------------------------------------------------------
@router.post("/admin/simulations",response_model=schemas.SimulationPublic,status_code=201)
def create_simulation(payload:schemas.SimulationCreate,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    state={"steps":[],"money_real":False,"inventory_real":False,"description":"Simulación aislada; no cobra, no descuenta inventario y no genera payout real."}
    row=models.SimulationRun(created_by_user_id=admin.id,scenario=payload.scenario,state_json=json.dumps(state,ensure_ascii=False));db.add(row);audit(db,admin.id,"simulation.create","simulation","",payload.scenario);db.commit();db.refresh(row);return row


@router.get("/admin/simulations",response_model=list[schemas.SimulationPublic])
def simulations(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    return db.scalars(select(models.SimulationRun).order_by(models.SimulationRun.created_at.desc()).limit(100)).all()


@router.post("/admin/simulations/{simulation_id}/advance",response_model=schemas.SimulationPublic)
def advance_simulation(simulation_id:int,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    row=db.get(models.SimulationRun,simulation_id)
    if not row:raise HTTPException(404,"Simulación no encontrada")
    if row.status=="completed":return row
    idx=SIM_STEPS.index(row.current_step) if row.current_step in SIM_STEPS else 0
    state=json.loads(row.state_json or "{}");history=state.setdefault("steps",[]);history.append({"step":row.current_step,"at":now().isoformat()})
    if row.scenario=="cancel_before_prep" and row.current_step=="restaurant_confirm":
        row.current_step="cancelled";row.status="completed";state["result"]="cancelled_without_real_charge"
    elif row.scenario=="no_driver" and row.current_step=="ready":
        row.current_step="dispatch_alert";row.status="completed";state["result"]="manual_dispatch_required"
    elif idx>=len(SIM_STEPS)-1:
        row.current_step="settled";row.status="completed";state["result"]="success"
    else:
        row.current_step=SIM_STEPS[idx+1]
    row.state_json=json.dumps(state,ensure_ascii=False);audit(db,admin.id,"simulation.advance","simulation",str(row.id),row.current_step);db.commit();db.refresh(row);return row


@router.post("/admin/simulations/{simulation_id}/run-all",response_model=schemas.SimulationPublic)
def run_all_simulation(simulation_id:int,admin:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    row=db.get(models.SimulationRun,simulation_id)
    if not row:raise HTTPException(404,"Simulación no encontrada")
    state=json.loads(row.state_json or "{}");state["steps"]=[{"step":step,"at":now().isoformat()} for step in SIM_STEPS];state["result"]="success" if row.scenario in {"happy_path","cash_delivery"} else row.scenario
    row.current_step="settled" if row.scenario in {"happy_path","cash_delivery"} else ("cancelled" if row.scenario=="cancel_before_prep" else "dispatch_alert");row.status="completed";row.state_json=json.dumps(state,ensure_ascii=False);audit(db,admin.id,"simulation.run_all","simulation",str(row.id),row.scenario);db.commit();db.refresh(row);return row
