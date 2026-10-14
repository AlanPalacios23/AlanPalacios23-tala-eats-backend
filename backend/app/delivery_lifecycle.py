from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .monetization import DEFAULTS, get_decimal_setting
from .realtime import publish_order_event
from .wallet import credit_wallet, get_loyalty_account


def finalize_delivery(db: Session, order: models.Order, actor_user_id: int, source: str, photo_url: str = "", lat=None, lng=None, update_driver_profile: bool = False) -> models.Order:
    if order.status == "delivered":
        return order
    order.status = "delivered"
    order.delivered_at = datetime.now(timezone.utc)
    if order.payment_method == "cash":
        order.payment_status = "paid"
        order.cash_collected = order.total
    if update_driver_profile and order.driver_id:
        profile = db.scalar(select(models.DriverProfile).where(models.DriverProfile.user_id == order.driver_id))
        if profile:
            profile.total_deliveries += 1
            profile.earnings_today += order.driver_earning + order.tip
    db.add(models.OrderEvent(order_id=order.id,status="delivered",actor_user_id=actor_user_id,metadata_json=f'{{"source":"{source}"}}'))
    existing_proof = db.scalar(select(models.DeliveryProof).where(models.DeliveryProof.order_id == order.id))
    if not existing_proof:
        db.add(models.DeliveryProof(order_id=order.id,driver_id=actor_user_id,pin_verified=True,photo_url=photo_url,lat=lat,lng=lng))

    account = get_loyalty_account(db, order.user_id, lock=True)
    earned = max(1, int(order.total // 10))
    account.points += earned
    previous = db.scalar(select(models.Order).where(models.Order.user_id==order.user_id,models.Order.status=="delivered",models.Order.id!=order.id,models.Order.delivered_at.is_not(None)).order_by(models.Order.delivered_at.desc()))
    if previous and previous.delivered_at:
        previous_date = previous.delivered_at.date() if previous.delivered_at.tzinfo else previous.delivered_at.replace(tzinfo=timezone.utc).date()
        gap = (order.delivered_at.date() - previous_date).days
        account.streak_days = (account.streak_days + 1) if gap <= 7 else 1
    else:
        account.streak_days = max(1, account.streak_days)
    account.tier = "BLACK" if account.points >= 3000 else "GOLD" if account.points >= 1500 else "SILVER" if account.points >= 600 else "BRONZE"
    db.add(models.ProductEvent(user_id=order.user_id,session_id="server",event_name="order_delivered",route=f"/pedido/{order.id}",properties_json=f'{{"order_id":{order.id}}}'))
    db.add(models.Notification(user_id=order.user_id,kind="reward",title="Puntos acreditados",message=f"Ganaste {earned} puntos por el pedido #{order.id}. Racha: {account.streak_days}."))

    referral = db.scalar(select(models.ReferralConversion).where(models.ReferralConversion.referred_user_id==order.user_id,models.ReferralConversion.status=="pending").with_for_update())
    if referral:
        reward = referral.reward_amount or get_decimal_setting(db,"referral_reward",DEFAULTS["referral_reward"])
        referrer_account = get_loyalty_account(db, referral.referrer_user_id, lock=True)
        referred_account = get_loyalty_account(db, referral.referred_user_id, lock=True)
        credit_wallet(db,referral.referrer_user_id,reward,kind="referral_reward",reference_type="referral",reference_id=str(referral.id),description="Recompensa por referido válido",idempotency_key=f"referral:{referral.id}:referrer",account=referrer_account)
        credit_wallet(db,referral.referred_user_id,reward,kind="referral_welcome",reference_type="referral",reference_id=str(referral.id),description="Recompensa de bienvenida por referido",idempotency_key=f"referral:{referral.id}:referred",account=referred_account)
        referral.qualifying_order_id = order.id
        referral.status = "rewarded"
        referral.rewarded_at = datetime.now(timezone.utc)

    db.add(models.Notification(user_id=order.user_id,kind="delivery",title="Pedido entregado",message=f"Pedido #{order.id} entregado. ¡Buen provecho!"))
    db.commit()
    publish_order_event(order.id,"order.status",{"status":"delivered"})
    return order
