from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import secrets

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(500), nullable=True)
    role: Mapped[str] = mapped_column(String(30), default="customer", index=True)
    auth_provider: Mapped[str] = mapped_column(String(30), default="local")
    google_sub: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    avatar_url: Mapped[str | None] = mapped_column(String(600), nullable=True)
    phone: Mapped[str] = mapped_column(String(30), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    two_factor_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    totp_secret: Mapped[str] = mapped_column(String(80), default="")
    marketing_opt_in: Mapped[bool] = mapped_column(Boolean, default=True)
    analytics_opt_in: Mapped[bool] = mapped_column(Boolean, default=True)
    personalization_opt_in: Mapped[bool] = mapped_column(Boolean, default=True)
    birth_date: Mapped[str] = mapped_column(String(10), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    restaurants: Mapped[list[Restaurant]] = relationship(back_populates="owner")
    orders: Mapped[list[Order]] = relationship(back_populates="customer", foreign_keys="Order.user_id")
    deliveries: Mapped[list[Order]] = relationship(back_populates="driver", foreign_keys="Order.driver_id")
    driver_profile: Mapped[DriverProfile | None] = relationship(back_populates="user", uselist=False, cascade="all, delete-orphan")


class DriverProfile(Base):
    __tablename__ = "driver_profiles"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True, index=True)
    vehicle: Mapped[str] = mapped_column(String(80), default="Motocicleta")
    plate: Mapped[str] = mapped_column(String(30), default="")
    is_online: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=True)
    rating: Mapped[Decimal] = mapped_column(Numeric(3, 2), default=Decimal("5.00"))
    total_deliveries: Mapped[int] = mapped_column(Integer, default=0)
    current_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    current_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    earnings_today: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    payout_account_ref: Mapped[str] = mapped_column(String(180), default="")
    user: Mapped[User] = relationship(back_populates="driver_profile")


class Restaurant(Base):
    __tablename__ = "restaurants"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    cuisine: Mapped[str] = mapped_column(String(100), default="Comida local")
    emoji: Mapped[str] = mapped_column(String(20), default="🍽️")
    eta_min: Mapped[int] = mapped_column(Integer, default=30)
    delivery_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    is_open: Mapped[bool] = mapped_column(Boolean, default=True)
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    lat: Mapped[float] = mapped_column(Float, default=20.6534)
    lng: Mapped[float] = mapped_column(Float, default=-103.7040)
    # Human-readable pickup address. Never infer this from Tala-wide default coordinates.
    address: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    delivery_radius_km: Mapped[float] = mapped_column(Float, default=8.0)
    per_km_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("4.00"))
    pickup_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sponsored: Mapped[bool] = mapped_column(Boolean, default=False)
    rating: Mapped[Decimal] = mapped_column(Numeric(3, 2), default=Decimal("4.80"))
    verification_status: Mapped[str] = mapped_column(String(30), default="verified")
    pos_webhook_url: Mapped[str] = mapped_column(String(600), default="")
    tax_id: Mapped[str] = mapped_column(String(40), default="")
    commercial_plan: Mapped[str] = mapped_column(String(30), default="START", index=True)
    commission_rate: Mapped[Decimal] = mapped_column(Numeric(6, 4), default=Decimal("0.1200"))
    service_fee_rate: Mapped[Decimal] = mapped_column(Numeric(6, 4), default=Decimal("0.0400"))
    service_fee_fixed: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    branch_code: Mapped[str] = mapped_column(String(40), default="MAIN", index=True)
    brand_name: Mapped[str] = mapped_column(String(150), default="")
    market_code: Mapped[str] = mapped_column(String(40), default="TALA-JAL", index=True)
    onboarding_status: Mapped[str] = mapped_column(String(30), default="approved", index=True)
    cover_image_url: Mapped[str] = mapped_column(String(600), default="")
    payout_account_ref: Mapped[str] = mapped_column(String(180), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    owner: Mapped[User | None] = relationship(back_populates="restaurants")
    menu_items: Mapped[list[MenuItem]] = relationship(back_populates="restaurant", cascade="all, delete-orphan")
    orders: Mapped[list[Order]] = relationship(back_populates="restaurant")


class MenuItem(Base):
    __tablename__ = "menu_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    restaurant_id: Mapped[int] = mapped_column(ForeignKey("restaurants.id"), index=True)
    name: Mapped[str] = mapped_column(String(150))
    description: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(100), default="General")
    price: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    is_available: Mapped[bool] = mapped_column(Boolean, default=True)
    stock: Mapped[int] = mapped_column(Integer, default=100)
    dietary_tags: Mapped[str] = mapped_column(String(300), default="")
    allergens: Mapped[str] = mapped_column(String(300), default="")
    is_combo: Mapped[bool] = mapped_column(Boolean, default=False)
    options_json: Mapped[str] = mapped_column(Text, default="[]")
    availability_schedule_json: Mapped[str] = mapped_column(Text, default="{}")
    price_schedule_json: Mapped[str] = mapped_column(Text, default="{}")
    image_url: Mapped[str] = mapped_column(String(600), default="")
    restaurant: Mapped[Restaurant] = relationship(back_populates="menu_items")


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (UniqueConstraint("user_id", "client_reference", name="uq_order_user_client_reference"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    restaurant_id: Mapped[int] = mapped_column(ForeignKey("restaurants.id"), index=True)
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(40), default="received", index=True)
    payment_method: Mapped[str] = mapped_column(String(30), default="cash")
    payment_status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    payment_provider: Mapped[str] = mapped_column(String(30), default="")
    payment_provider_id: Mapped[str] = mapped_column(String(120), default="", index=True)
    payment_preference_id: Mapped[str] = mapped_column(String(160), default="")
    subtotal: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    delivery_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    discount: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    tip: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    total: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    platform_commission: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    service_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    payment_processing_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    refunded_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    # Snapshot of ingredient quantities reserved at checkout. This lets cancellation/refund
    # restore the exact reservation even if the restaurant edits a recipe later.
    inventory_reserved_json: Mapped[str] = mapped_column(Text, default="{}")
    # Non-null means reserved menu/ingredient inventory has already been restored.
    # The marker is committed atomically with the stock update, making retries safe.
    inventory_restored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    promotion_subsidy: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    platform_revenue: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    contribution_margin: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    cash_collected: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    cancellation_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    restaurant_payout: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    driver_earning: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    address: Mapped[str] = mapped_column(String(300))
    notes: Mapped[str] = mapped_column(Text, default="")
    recipient_name: Mapped[str] = mapped_column(String(120), default="")
    recipient_phone: Mapped[str] = mapped_column(String(40), default="")
    gift_message: Mapped[str] = mapped_column(String(300), default="")
    delivery_pin: Mapped[str] = mapped_column(String(4), default=lambda: f"{secrets.randbelow(10000):04d}")
    order_type: Mapped[str] = mapped_column(String(20), default="delivery")
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    coupon_code: Mapped[str] = mapped_column(String(50), default="")
    group_code: Mapped[str] = mapped_column(String(12), default="")
    distance_km: Mapped[float] = mapped_column(Float, default=2.5)
    delivery_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    delivery_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    estimated_minutes: Mapped[int] = mapped_column(Integer, default=30)
    invoice_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    invoice_tax_id: Mapped[str] = mapped_column(String(40), default="")
    proof_required: Mapped[bool] = mapped_column(Boolean, default=True)
    cancelled_reason: Mapped[str] = mapped_column(String(300), default="")
    client_reference: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    corporate_account_id: Mapped[int | None] = mapped_column(ForeignKey("corporate_accounts.id"), nullable=True, index=True)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    preparing_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    picked_up_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    customer: Mapped[User] = relationship(back_populates="orders", foreign_keys=[user_id])
    driver: Mapped[User | None] = relationship(back_populates="deliveries", foreign_keys=[driver_id])
    restaurant: Mapped[Restaurant] = relationship(back_populates="orders")
    items: Mapped[list[OrderItem]] = relationship(back_populates="order", cascade="all, delete-orphan")

    @property
    def driver_info(self):
        if not self.driver:
            return None
        profile = self.driver.driver_profile
        return {"id": self.driver.id, "name": self.driver.name, "phone": self.driver.phone, "avatar_url": self.driver.avatar_url,
                "vehicle": profile.vehicle if profile else "Motocicleta", "rating": profile.rating if profile else Decimal("5.00"),
                "current_lat": profile.current_lat if profile else None, "current_lng": profile.current_lng if profile else None}


class OrderItem(Base):
    __tablename__ = "order_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    menu_item_id: Mapped[int | None] = mapped_column(ForeignKey("menu_items.id"), nullable=True)
    name_snapshot: Mapped[str] = mapped_column(String(150))
    quantity: Mapped[int] = mapped_column(Integer)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    options_snapshot: Mapped[str] = mapped_column(Text, default="")
    order: Mapped[Order] = relationship(back_populates="items")


class Address(Base):
    __tablename__ = "addresses"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    label: Mapped[str] = mapped_column(String(60), default="Casa")
    address: Mapped[str] = mapped_column(String(300))
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)


class Favorite(Base):
    __tablename__ = "favorites"
    __table_args__ = (UniqueConstraint("user_id", "restaurant_id", name="uq_favorite"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    restaurant_id: Mapped[int] = mapped_column(ForeignKey("restaurants.id"), index=True)


class Coupon(Base):
    __tablename__ = "coupons"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    discount_type: Mapped[str] = mapped_column(String(20), default="percent")
    value: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("10.00"))
    min_order: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    description: Mapped[str] = mapped_column(String(200), default="")


class Promotion(Base):
    __tablename__ = "promotions"
    id: Mapped[int] = mapped_column(primary_key=True)
    restaurant_id: Mapped[int | None] = mapped_column(ForeignKey("restaurants.id"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(150))
    description: Mapped[str] = mapped_column(String(300), default="")
    discount_percent: Mapped[int] = mapped_column(Integer, default=10)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    sponsored: Mapped[bool] = mapped_column(Boolean, default=False)


class Review(Base):
    __tablename__ = "reviews"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    restaurant_id: Mapped[int] = mapped_column(ForeignKey("restaurants.id"), index=True)
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    restaurant_rating: Mapped[int] = mapped_column(Integer)
    driver_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    comment: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(50), default="system")
    title: Mapped[str] = mapped_column(String(150))
    message: Mapped[str] = mapped_column(String(500))
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    message: Mapped[str] = mapped_column(String(1000))
    message_type: Mapped[str] = mapped_column(String(30), default="text")
    media_url: Mapped[str] = mapped_column(String(600), default="")
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class LoyaltyAccount(Base):
    __tablename__ = "loyalty_accounts"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True, index=True)
    points: Mapped[int] = mapped_column(Integer, default=0)
    tier: Mapped[str] = mapped_column(String(20), default="BRONZE")
    streak_days: Mapped[int] = mapped_column(Integer, default=0)
    plus_savings: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    wallet_balance: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    plus_member: Mapped[bool] = mapped_column(Boolean, default=False)
    referral_code: Mapped[str] = mapped_column(String(20), unique=True, index=True)


class WalletTransaction(Base):
    __tablename__ = "wallet_transactions"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    balance_after: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    reference_type: Mapped[str] = mapped_column(String(40), default="")
    reference_id: Mapped[str] = mapped_column(String(120), default="")
    description: Mapped[str] = mapped_column(String(300), default="")
    idempotency_key: Mapped[str | None] = mapped_column(String(180), nullable=True, unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class GiftCard(Base):
    __tablename__ = "gift_cards"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    balance: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class SupportTicket(Base):
    __tablename__ = "support_tickets"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    category: Mapped[str] = mapped_column(String(80))
    message: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(30), default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RestaurantEmployee(Base):
    __tablename__ = "restaurant_employees"
    id: Mapped[int] = mapped_column(primary_key=True)
    restaurant_id: Mapped[int] = mapped_column(ForeignKey("restaurants.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(30), default="cashier")


class VerificationRecord(Base):
    __tablename__ = "verification_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(30))
    entity_id: Mapped[int] = mapped_column(Integer, index=True)
    status: Mapped[str] = mapped_column(String(30), default="pending")
    notes: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FraudFlag(Base):
    __tablename__ = "fraud_flags"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True, index=True)
    reason: Mapped[str] = mapped_column(String(300))
    severity: Mapped[str] = mapped_column(String(20), default="medium", index=True)
    risk_score: Mapped[int] = mapped_column(Integer, default=0, index=True)
    signal: Mapped[str] = mapped_column(String(80), default="rules", index=True)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class DeliveryProof(Base):
    __tablename__ = "delivery_proofs"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), unique=True, index=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    pin_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    photo_url: Mapped[str] = mapped_column(String(600), default="")
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PaymentEvent(Base):
    __tablename__ = "payment_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(30), index=True)
    provider_event_id: Mapped[str] = mapped_column(String(220), unique=True, index=True)
    event_type: Mapped[str] = mapped_column(String(80), default="payment")
    payload: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EmailOutbox(Base):
    __tablename__ = "email_outbox"
    id: Mapped[int] = mapped_column(primary_key=True)
    to_email: Mapped[str] = mapped_column(String(255), index=True)
    subject: Mapped[str] = mapped_column(String(220))
    text_body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str] = mapped_column(String(500), default="")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(100), index=True)
    entity_type: Mapped[str] = mapped_column(String(80), default="")
    entity_id: Mapped[str] = mapped_column(String(120), default="")
    detail: Mapped[str] = mapped_column(Text, default="")
    request_id: Mapped[str] = mapped_column(String(128), default="", index=True)
    ip_address: Mapped[str] = mapped_column(String(80), default="")
    device_session_id: Mapped[int | None] = mapped_column(ForeignKey("device_sessions.id"), nullable=True, index=True)
    before_json: Mapped[str] = mapped_column(Text, default="{}")
    after_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class OnboardingApplication(Base):
    __tablename__ = "onboarding_applications"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    entity_type: Mapped[str] = mapped_column(String(30), index=True)
    business_name: Mapped[str] = mapped_column(String(160), default="")
    tax_id: Mapped[str] = mapped_column(String(60), default="")
    vehicle: Mapped[str] = mapped_column(String(100), default="")
    documents_json: Mapped[str] = mapped_column(Text, default="[]")
    payout_account_ref: Mapped[str] = mapped_column(String(180), default="")
    status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ServiceZone(Base):
    __tablename__ = "service_zones"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    center_lat: Mapped[float] = mapped_column(Float)
    center_lng: Mapped[float] = mapped_column(Float)
    radius_km: Mapped[float] = mapped_column(Float, default=8.0)
    surcharge: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    min_order: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FinancialLedgerEntry(Base):
    __tablename__ = "financial_ledger_entries"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    restaurant_id: Mapped[int | None] = mapped_column(ForeignKey("restaurants.id"), nullable=True, index=True)
    account: Mapped[str] = mapped_column(String(60), index=True)
    direction: Mapped[str] = mapped_column(String(10), default="credit")
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0.00"))
    currency: Mapped[str] = mapped_column(String(8), default="MXN")
    kind: Mapped[str] = mapped_column(String(60), index=True)
    description: Mapped[str] = mapped_column(String(300), default="")
    idempotency_key: Mapped[str] = mapped_column(String(180), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class Payout(Base):
    __tablename__ = "payouts"
    id: Mapped[int] = mapped_column(primary_key=True)
    payee_type: Mapped[str] = mapped_column(String(30), index=True)
    payee_id: Mapped[int] = mapped_column(Integer, index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(8), default="MXN")
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    provider_ref: Mapped[str] = mapped_column(String(180), default="")
    provider: Mapped[str] = mapped_column(String(40), default="manual")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    failure_reason: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WithdrawalRequest(Base):
    """On-demand bank payouts. Never use Payout or order snapshots as available cash."""
    __tablename__ = "withdrawal_requests"
    __table_args__ = (
        UniqueConstraint("payee_type", "payee_id", "client_key", name="uq_withdrawal_payee_key"),
        UniqueConstraint("requested_by", "otp_step", name="uq_withdrawal_one_use_per_totp"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    payee_type: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    payee_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    requested_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    connected_account_id: Mapped[str] = mapped_column(String(120), nullable=False)
    bank_destination_id: Mapped[str | None] = mapped_column(String(180), nullable=True)
    client_key: Mapped[str] = mapped_column(String(100), nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    otp_step: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="MXN")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="reserved", index=True)
    stripe_payout_id: Mapped[str | None] = mapped_column(String(180), nullable=True, unique=True)
    error_code: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class CashSettlement(Base):
    __tablename__ = "cash_settlements"
    id: Mapped[int] = mapped_column(primary_key=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    period_label: Mapped[str] = mapped_column(String(60), default="")
    cash_collected: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0.00"))
    driver_earnings: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0.00"))
    amount_due_platform: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0.00"))
    status: Mapped[str] = mapped_column(String(30), default="open", index=True)
    notes: Mapped[str] = mapped_column(String(400), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Dispute(Base):
    __tablename__ = "disputes"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    opened_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    category: Mapped[str] = mapped_column(String(80), index=True)
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(30), default="open", index=True)
    resolution: Mapped[str] = mapped_column(Text, default="")
    refund_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    assigned_to_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PlusSubscription(Base):
    __tablename__ = "plus_subscriptions"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    plan: Mapped[str] = mapped_column(String(30), default="PLUS")
    price_monthly: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("79.00"))
    status: Mapped[str] = mapped_column(String(30), default="active", index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    renews_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SponsoredCampaign(Base):
    __tablename__ = "sponsored_campaigns"
    id: Mapped[int] = mapped_column(primary_key=True)
    restaurant_id: Mapped[int] = mapped_column(ForeignKey("restaurants.id"), index=True)
    name: Mapped[str] = mapped_column(String(150))
    daily_budget: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("100.00"))
    spent: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    impressions: Mapped[int] = mapped_column(Integer, default=0)
    clicks: Mapped[int] = mapped_column(Integer, default=0)
    attributed_orders: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ReferralConversion(Base):
    __tablename__ = "referral_conversions"
    id: Mapped[int] = mapped_column(primary_key=True)
    referrer_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    referred_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True, index=True)
    referral_code: Mapped[str] = mapped_column(String(30), index=True)
    qualifying_order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    reward_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("50.00"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    rewarded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FeatureFlag(Base):
    __tablename__ = "feature_flags"
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    description: Mapped[str] = mapped_column(String(300), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    rollout_percent: Mapped[int] = mapped_column(Integer, default=100)
    audience_role: Mapped[str] = mapped_column(String(30), default="all")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class SystemSetting(Base):
    __tablename__ = "system_settings"
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    value: Mapped[str] = mapped_column(String(500), default="")
    value_type: Mapped[str] = mapped_column(String(30), default="string")
    description: Mapped[str] = mapped_column(String(300), default="")
    updated_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class OrderEvent(Base):
    __tablename__ = "order_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    status: Mapped[str] = mapped_column(String(40), index=True)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    metadata_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class SimulationRun(Base):
    __tablename__ = "simulation_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    scenario: Mapped[str] = mapped_column(String(80), default="happy_path")
    status: Mapped[str] = mapped_column(String(30), default="created", index=True)
    current_step: Mapped[str] = mapped_column(String(60), default="customer_order")
    state_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

# ---------------------------------------------------------------------------
# V9 — Intelligence, Growth & Automation
# ---------------------------------------------------------------------------
class ProductEvent(Base):
    __tablename__ = "product_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    session_id: Mapped[str] = mapped_column(String(80), default="", index=True)
    event_name: Mapped[str] = mapped_column(String(100), index=True)
    route: Mapped[str] = mapped_column(String(240), default="")
    properties_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class Experiment(Base):
    __tablename__ = "experiments"
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(180))
    variants_json: Mapped[str] = mapped_column(Text, default='["control","variant"]')
    audience_role: Mapped[str] = mapped_column(String(30), default="customer")
    rollout_percent: Mapped[int] = mapped_column(Integer, default=100)
    status: Mapped[str] = mapped_column(String(30), default="draft", index=True)
    primary_metric: Mapped[str] = mapped_column(String(100), default="checkout_completed")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ExperimentAssignment(Base):
    __tablename__ = "experiment_assignments"
    __table_args__ = (UniqueConstraint("experiment_id", "user_id", name="uq_experiment_user"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    experiment_id: Mapped[int] = mapped_column(ForeignKey("experiments.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    variant: Mapped[str] = mapped_column(String(60))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DriverIncentive(Base):
    __tablename__ = "driver_incentives"
    id: Mapped[int] = mapped_column(primary_key=True)
    zone_name: Mapped[str] = mapped_column(String(120), default="General", index=True)
    title: Mapped[str] = mapped_column(String(180))
    bonus_per_delivery: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    multiplier: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("1.00"))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)


class OperationalIncident(Base):
    __tablename__ = "operational_incidents"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True, index=True)
    incident_type: Mapped[str] = mapped_column(String(80), index=True)
    severity: Mapped[str] = mapped_column(String(20), default="medium", index=True)
    title: Mapped[str] = mapped_column(String(180))
    detail: Mapped[str] = mapped_column(Text, default="")
    recommended_action: Mapped[str] = mapped_column(String(400), default="")
    status: Mapped[str] = mapped_column(String(30), default="open", index=True)
    assigned_to_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MarketingAutomation(Base):
    __tablename__ = "marketing_automations"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(180))
    trigger_type: Mapped[str] = mapped_column(String(80), index=True)
    segment: Mapped[str] = mapped_column(String(80), default="all")
    channel: Mapped[str] = mapped_column(String(30), default="in_app")
    coupon_code: Mapped[str] = mapped_column(String(50), default="")
    message_template: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class IngredientStock(Base):
    __tablename__ = "ingredient_stocks"
    id: Mapped[int] = mapped_column(primary_key=True)
    restaurant_id: Mapped[int] = mapped_column(ForeignKey("restaurants.id"), index=True)
    name: Mapped[str] = mapped_column(String(140), index=True)
    unit: Mapped[str] = mapped_column(String(30), default="unit")
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal("0"))
    reorder_level: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal("0"))
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class MenuRecipe(Base):
    __tablename__ = "menu_recipes"
    __table_args__ = (UniqueConstraint("menu_item_id", "ingredient_id", name="uq_recipe_component"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    menu_item_id: Mapped[int] = mapped_column(ForeignKey("menu_items.id"), index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredient_stocks.id"), index=True)
    quantity_required: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal("1"))


class WasteRecord(Base):
    __tablename__ = "waste_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    restaurant_id: Mapped[int] = mapped_column(ForeignKey("restaurants.id"), index=True)
    ingredient_id: Mapped[int | None] = mapped_column(ForeignKey("ingredient_stocks.id"), nullable=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal("0"))
    reason: Mapped[str] = mapped_column(String(180), default="")
    estimated_cost: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class CorporateAccount(Base):
    __tablename__ = "corporate_accounts"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(180), unique=True, index=True)
    join_code: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    monthly_budget: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    cost_center: Mapped[str] = mapped_column(String(80), default="GENERAL")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CorporateMember(Base):
    __tablename__ = "corporate_members"
    __table_args__ = (UniqueConstraint("corporate_account_id", "user_id", name="uq_corporate_member"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    corporate_account_id: Mapped[int] = mapped_column(ForeignKey("corporate_accounts.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    employee_code: Mapped[str] = mapped_column(String(80), default="")
    individual_budget: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class PrivacyRequest(Base):
    __tablename__ = "privacy_requests"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    request_type: Mapped[str] = mapped_column(String(30), index=True)
    status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    result_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PartnerApiKey(Base):
    __tablename__ = "partner_api_keys"
    id: Mapped[int] = mapped_column(primary_key=True)
    partner_name: Mapped[str] = mapped_column(String(180), index=True)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    scopes: Mapped[str] = mapped_column(String(500), default="catalog:read,orders:read")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DeviceSession(Base):
    __tablename__ = "device_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    session_hash: Mapped[str] = mapped_column(String(64), index=True)
    device_id_hash: Mapped[str] = mapped_column(String(64), default="", index=True)
    device_label: Mapped[str] = mapped_column(String(200), default="")
    platform: Mapped[str] = mapped_column(String(40), default="unknown", index=True)
    ip_hint: Mapped[str] = mapped_column(String(80), default="")
    risk_score: Mapped[int] = mapped_column(Integer, default=0)
    trusted: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GroupCart(Base):
    __tablename__ = "group_carts"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(12), unique=True, index=True)
    restaurant_id: Mapped[int] = mapped_column(ForeignKey("restaurants.id"), index=True)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GroupCartItem(Base):
    __tablename__ = "group_cart_items"
    __table_args__ = (UniqueConstraint("group_cart_id", "user_id", "menu_item_id", name="uq_group_cart_user_item"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    group_cart_id: Mapped[int] = mapped_column(ForeignKey("group_carts.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    menu_item_id: Mapped[int] = mapped_column(ForeignKey("menu_items.id"), index=True)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    options: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

# ---------------------------------------------------------------------------
# V11 Launch Ready models
# ---------------------------------------------------------------------------
class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    __table_args__ = (UniqueConstraint("user_id", "endpoint", name="uq_push_user_endpoint"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    endpoint: Mapped[str] = mapped_column(String(1200))
    p256dh: Mapped[str] = mapped_column(String(300), default="")
    auth: Mapped[str] = mapped_column(String(300), default="")
    platform: Mapped[str] = mapped_column(String(40), default="web")
    device_label: Mapped[str] = mapped_column(String(200), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class RefundAdjustment(Base):
    __tablename__ = "refund_adjustments"
    __table_args__ = (UniqueConstraint("idempotency_key", name="uq_refund_adjustment_idem"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    reason: Mapped[str] = mapped_column(String(300), default="")
    provider: Mapped[str] = mapped_column(String(40), default="")
    provider_ref: Mapped[str] = mapped_column(String(220), default="")
    status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    idempotency_key: Mapped[str] = mapped_column(String(180), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SubstitutionRequest(Base):
    __tablename__ = "substitution_requests"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    order_item_id: Mapped[int] = mapped_column(ForeignKey("order_items.id"), index=True)
    restaurant_id: Mapped[int] = mapped_column(ForeignKey("restaurants.id"), index=True)
    requested_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    replacement_menu_item_id: Mapped[int | None] = mapped_column(ForeignKey("menu_items.id"), nullable=True)
    issue_type: Mapped[str] = mapped_column(String(40), default="unavailable")
    message: Mapped[str] = mapped_column(String(500), default="")
    original_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    replacement_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    resolution: Mapped[str] = mapped_column(String(40), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DriverOffer(Base):
    __tablename__ = "driver_offers"
    __table_args__ = (UniqueConstraint("order_id", "driver_id", "round_no", name="uq_driver_offer_round"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    round_no: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(30), default="offered", index=True)
    score: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_pickup_min: Mapped[int] = mapped_column(Integer, default=10)
    estimated_earning: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    offered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class EventOutbox(Base):
    __tablename__ = "event_outbox"
    __table_args__ = (UniqueConstraint("event_key", name="uq_event_outbox_event_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    event_key: Mapped[str] = mapped_column(String(220), index=True)
    aggregate_type: Mapped[str] = mapped_column(String(60), index=True)
    aggregate_id: Mapped[str] = mapped_column(String(120), index=True)
    event_type: Mapped[str] = mapped_column(String(120), index=True)
    payload_json: Mapped[str] = mapped_column(Text, default="{}")
    status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(String(1000), default="")
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class DeadLetterJob(Base):
    __tablename__ = "dead_letter_jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(60), index=True)
    source_id: Mapped[str] = mapped_column(String(120), default="", index=True)
    kind: Mapped[str] = mapped_column(String(120), index=True)
    payload_json: Mapped[str] = mapped_column(Text, default="{}")
    error: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(30), default="open", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PaymentReconciliation(Base):
    __tablename__ = "payment_reconciliations"
    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(40), default="mercadopago", index=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True, index=True)
    provider_payment_id: Mapped[str] = mapped_column(String(160), default="", index=True)
    local_status: Mapped[str] = mapped_column(String(40), default="")
    provider_status: Mapped[str] = mapped_column(String(40), default="")
    action: Mapped[str] = mapped_column(String(80), default="none", index=True)
    detail: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(30), default="checked", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class SystemAlert(Base):
    __tablename__ = "system_alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    alert_key: Mapped[str] = mapped_column(String(160), index=True)
    severity: Mapped[str] = mapped_column(String(20), default="warning", index=True)
    component: Mapped[str] = mapped_column(String(60), default="backend", index=True)
    message: Mapped[str] = mapped_column(String(500))
    detail_json: Mapped[str] = mapped_column(Text, default="{}")
    status: Mapped[str] = mapped_column(String(30), default="open", index=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class IntegrationEvent(Base):
    __tablename__ = "integration_events"
    __table_args__ = (UniqueConstraint("provider", "external_id", name="uq_integration_event_provider_external"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(60), index=True)
    external_id: Mapped[str] = mapped_column(String(220), index=True)
    event_type: Mapped[str] = mapped_column(String(100), default="event")
    status: Mapped[str] = mapped_column(String(30), default="received", index=True)
    payload: Mapped[str] = mapped_column(Text, default="")
    last_error: Mapped[str] = mapped_column(String(500), default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StripeTransfer(Base):
    __tablename__ = "stripe_transfers"
    __table_args__ = (UniqueConstraint("order_id", "recipient_type", name="uq_stripe_transfer_order_recipient"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    recipient_type: Mapped[str] = mapped_column(String(30))
    connected_account_id: Mapped[str] = mapped_column(String(120))
    amount_cents: Mapped[int] = mapped_column(Integer)
    transfer_id: Mapped[str] = mapped_column(String(150), default="")
    status: Mapped[str] = mapped_column(String(30), default="pending")
    last_error: Mapped[str] = mapped_column(String(1000), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


# V1.5.3: native push fanout. New tables only; existing notifications unchanged.
class MobilePushDevice(Base):
    __tablename__ = "mobile_push_devices"
    __table_args__ = (UniqueConstraint("token_hash", name="uq_mobile_push_token_hash"),
                      UniqueConstraint("user_id", "application", "device_id", name="uq_mobile_push_user_app_device"))
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    application: Mapped[str] = mapped_column(String(20), nullable=False)
    platform: Mapped[str] = mapped_column(String(10), nullable=False)
    device_id: Mapped[str] = mapped_column(String(96), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    encrypted_token: Mapped[str] = mapped_column(Text, nullable=False)
    marketing_push_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class MobilePushDelivery(Base):
    __tablename__ = "mobile_push_deliveries"
    __table_args__ = (UniqueConstraint("notification_id", "device_id", name="uq_mobile_push_notification_device"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    notification_id: Mapped[int] = mapped_column(ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False, index=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("mobile_push_devices.id", ondelete="CASCADE"), nullable=False, index=True)
    state: Mapped[str] = mapped_column(String(16), default="queued", nullable=False, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    claimed_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(String(240), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


# FINANCE CORE V2 — isolated shadow accounting, feature-flagged OFF by default.
# These tables DO NOT authorize bank transfers, Stripe movements or collections.
class FinanceV2Wallet(Base):
    __tablename__ = "finance_v2_wallets"
    __table_args__ = (UniqueConstraint("owner_type", "owner_id", name="uq_fin_v2_wallet_owner"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_type: Mapped[str] = mapped_column(String(20), nullable=False)
    owner_id: Mapped[int] = mapped_column(Integer, nullable=False)
    balance_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # This portion of positive credits is NOT payable until PSP/bank funding is verified.
    unfunded_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Physical cash under this participant's custody (not money in Tala Eats' bank).
    cash_exposure_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="MXN")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class FinanceV2Journal(Base):
    __tablename__ = "finance_v2_journals"
    __table_args__ = (UniqueConstraint("order_id", "event_type", name="uq_fin_v2_order_event"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(35), nullable=False, default="delivered")
    payment_method: Mapped[str] = mapped_column(String(30), nullable=False)
    total_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    # Platform revenue here is accrued; it is NOT a bank balance.
    platform_revenue_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="MXN")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FinanceV2JournalLine(Base):
    __tablename__ = "finance_v2_journal_lines"
    __table_args__ = (UniqueConstraint("journal_id", "seq", name="uq_fin_v2_journal_seq"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    journal_id: Mapped[int] = mapped_column(ForeignKey("finance_v2_journals.id"), index=True, nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    account: Mapped[str] = mapped_column(String(90), nullable=False, index=True)
    direction: Mapped[str] = mapped_column(String(6), nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    owner_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    owner_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class FinanceV2WalletMovement(Base):
    __tablename__ = "finance_v2_wallet_movements"
    __table_args__ = (UniqueConstraint("journal_id", "owner_type", "owner_id", name="uq_fin_v2_mov_wallet"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    journal_id: Mapped[int] = mapped_column(ForeignKey("finance_v2_journals.id"), nullable=False, index=True)
    owner_type: Mapped[str] = mapped_column(String(20), nullable=False)
    owner_id: Mapped[int] = mapped_column(Integer, nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    unfunded_delta_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cash_exposure_delta_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FinanceV2CashAllocation(Base):
    __tablename__ = "finance_v2_cash_allocations"
    __table_args__ = (UniqueConstraint("order_id", name="uq_fin_v2_cash_order"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), nullable=False, index=True)
    journal_id: Mapped[int] = mapped_column(ForeignKey("finance_v2_journals.id"), nullable=False)
    collector_type: Mapped[str] = mapped_column(String(20), nullable=False)
    collector_id: Mapped[int] = mapped_column(Integer, nullable=False)
    received_cash_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    owed_by_collector_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    # recorded != reconciled. Reconciliation with PSP/bank is future work.
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="recorded")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
