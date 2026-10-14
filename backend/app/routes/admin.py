from decimal import Decimal
from uuid import uuid4
from fastapi import APIRouter,Depends,HTTPException,Query
from sqlalchemy import func,select
from sqlalchemy.orm import Session, selectinload
from .. import models,schemas
from ..db import get_db
from ..config import settings
from ..deps import require_role
from ..wallet import credit_wallet, debit_wallet, get_loyalty_account
router=APIRouter(prefix="/api/v1/admin",tags=["admin"])
@router.get("/stats",response_model=schemas.AdminStats)
def stats(_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    active=["received","confirmed","preparing","ready","assigned","picked_up","on_the_way"]
    def count(model,*where):return db.scalar(select(func.count(model.id)).where(*where)) or 0
    gross=db.scalar(select(func.coalesce(func.sum(models.Order.total),0)).where(models.Order.status!="cancelled")) or 0
    comm=db.scalar(select(func.coalesce(func.sum(models.Order.platform_commission),0)).where(models.Order.status!="cancelled")) or 0
    return schemas.AdminStats(users=count(models.User),customers=count(models.User,models.User.role=="customer"),restaurants=count(models.Restaurant),drivers=count(models.User,models.User.role=="driver"),online_drivers=count(models.DriverProfile,models.DriverProfile.is_online.is_(True)),menu_items=count(models.MenuItem),orders=count(models.Order),active_orders=count(models.Order,models.Order.status.in_(active)),gross_sales=Decimal(str(gross)),commissions=Decimal(str(comm)),support_open=count(models.SupportTicket,models.SupportTicket.status=="open"),fraud_flags=count(models.FraudFlag,models.FraudFlag.resolved.is_(False)),plus_members=count(models.LoyaltyAccount,models.LoyaltyAccount.plus_member.is_(True)))
@router.get("/users",response_model=list[schemas.UserPublic])
def users(limit:int=Query(default=100,ge=1,le=200),offset:int=Query(default=0,ge=0,le=1_000_000),_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    return db.scalars(select(models.User).order_by(models.User.created_at.desc()).offset(offset).limit(limit)).all()
@router.post("/restaurants",response_model=schemas.RestaurantPublic,status_code=201)
def create(payload:schemas.RestaurantCreate,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    owner=None
    if payload.owner_email:
        owner=db.scalar(select(models.User).where(models.User.email==payload.owner_email.lower()))
        if not owner:raise HTTPException(404,"Usuario no encontrado")
        owner.role="restaurant"
    data=payload.model_dump(exclude={"owner_email"});r=models.Restaurant(**data,owner_id=owner.id if owner else None);db.add(r);db.commit();db.refresh(r);return r
@router.patch("/users/{user_id}/active",response_model=schemas.UserPublic)
def toggle(user_id:int,active:bool,current:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    u=db.get(models.User,user_id)
    if not u:raise HTTPException(404,"Usuario no encontrado")
    if u.id==current.id and not active:raise HTTPException(400,"No puedes desactivar tu cuenta")
    u.is_active=active;db.commit();db.refresh(u);return u

@router.get("/orders", response_model=list[schemas.OrderOperationalPublic])
def admin_orders(limit:int=Query(default=100,ge=1,le=250),offset:int=Query(default=0,ge=0,le=1_000_000),_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    return db.scalars(select(models.Order).options(selectinload(models.Order.items),selectinload(models.Order.driver).selectinload(models.User.driver_profile)).order_by(models.Order.created_at.desc()).offset(offset).limit(limit)).all()

@router.get("/fraud")
def fraud(limit:int=Query(default=100,ge=1,le=250),_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    return [{"id":x.id,"user_id":x.user_id,"order_id":x.order_id,"reason":x.reason,"severity":x.severity,"resolved":x.resolved} for x in db.scalars(select(models.FraudFlag).order_by(models.FraudFlag.created_at.desc()).limit(limit)).all()]
@router.get("/verifications")
def verifications(limit:int=Query(default=100,ge=1,le=250),_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    return [{"id":x.id,"entity_type":x.entity_type,"entity_id":x.entity_id,"status":x.status,"notes":x.notes} for x in db.scalars(select(models.VerificationRecord).limit(limit)).all()]

@router.patch("/fraud/{flag_id}/resolved")
def resolve_fraud(flag_id:int,resolved:bool=True,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    row=db.get(models.FraudFlag,flag_id)
    if not row: raise HTTPException(404,"Señal no encontrada")
    row.resolved=resolved;db.commit()
    return {"id":row.id,"resolved":row.resolved}

@router.patch("/restaurants/{restaurant_id}/verification")
def verify_restaurant(restaurant_id:int,status:str="verified",_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    if status not in {"pending","verified","rejected","suspended"}: raise HTTPException(400,"Estado inválido")
    row=db.get(models.Restaurant,restaurant_id)
    if not row: raise HTTPException(404,"Restaurante no encontrado")
    row.verification_status=status;db.commit()
    return {"id":row.id,"verification_status":row.verification_status}

@router.patch("/drivers/{user_id}/verified")
def verify_driver(user_id:int,verified:bool=True,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    row=db.scalar(select(models.DriverProfile).where(models.DriverProfile.user_id==user_id))
    if not row: raise HTTPException(404,"Perfil de repartidor no encontrado")
    row.is_verified=verified;db.commit()
    return {"user_id":user_id,"is_verified":row.is_verified}

@router.patch("/verifications/{record_id}")
def update_verification(record_id:int,status:str,notes:str="",_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    if status not in {"pending","approved","rejected","needs_info"}: raise HTTPException(400,"Estado inválido")
    row=db.get(models.VerificationRecord,record_id)
    if not row: raise HTTPException(404,"Verificación no encontrada")
    row.status=status;row.notes=notes[:500];db.commit()
    return {"id":row.id,"status":row.status,"notes":row.notes}


@router.get("/wallet/{user_id}", response_model=schemas.WalletSummary)
def admin_wallet(user_id:int,_:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    user=db.get(models.User,user_id)
    if not user: raise HTTPException(404,"Usuario no encontrado")
    account=get_loyalty_account(db,user_id);db.commit();db.refresh(account)
    tx=db.scalars(select(models.WalletTransaction).where(models.WalletTransaction.user_id==user_id).order_by(models.WalletTransaction.created_at.desc()).limit(50)).all()
    return {"balance":account.wallet_balance,"points":account.points,"plus_member":account.plus_member,"referral_code":account.referral_code,"transactions":tx}


@router.post("/wallet/{user_id}/adjust", response_model=schemas.WalletSummary)
def admin_wallet_adjust(user_id:int,payload:schemas.WalletAdminAdjustment,current:models.User=Depends(require_role("admin")),db:Session=Depends(get_db)):
    target=db.get(models.User,user_id)
    if not target: raise HTTPException(404,"Usuario no encontrado")
    amount=Decimal(payload.amount)
    if abs(amount) > Decimal(str(settings.wallet_max_adjustment)):
        raise HTTPException(400,"El ajuste excede el máximo permitido por operación")
    account=get_loyalty_account(db,user_id,lock=True)
    key=f"admin-adjust:{current.id}:{user_id}:{uuid4()}"
    if amount > 0:
        credit_wallet(db,user_id,amount,kind="admin_adjustment",reference_type="admin",reference_id=str(current.id),description=payload.reason,idempotency_key=key,account=account)
    else:
        debit_wallet(db,user_id,-amount,kind="admin_adjustment",reference_type="admin",reference_id=str(current.id),description=payload.reason,idempotency_key=key,account=account)
    db.add(models.Notification(user_id=user_id,kind="wallet",title="Ajuste de Tala Wallet",message=f"ADMIN registró un ajuste de ${amount} en tu Wallet. Motivo: {payload.reason}"))
    db.commit();db.refresh(account)
    tx=db.scalars(select(models.WalletTransaction).where(models.WalletTransaction.user_id==user_id).order_by(models.WalletTransaction.created_at.desc()).limit(50)).all()
    return {"balance":account.wallet_balance,"points":account.points,"plus_member":account.plus_member,"referral_code":account.referral_code,"transactions":tx}
