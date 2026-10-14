from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models

CENT = Decimal('0.01')

DEFAULTS = {
    'service_fee_rate': Decimal('0.0400'),
    'service_fee_min': Decimal('5.00'),
    'driver_share_of_delivery_fee': Decimal('0.7000'),
    'payment_processing_rate': Decimal('0.0350'),
    'payment_processing_fixed': Decimal('4.00'),
    'plus_monthly_price': Decimal('79.00'),
    'referral_reward': Decimal('50.00'),
    'restaurant_commission_start': Decimal('0.1000'),
    'restaurant_commission_delivery': Decimal('0.1500'),
    'restaurant_commission_pro': Decimal('0.1800'),
    # v1.5.2 commercial policy (new orders only; legacy policy remains switchable).
    'commercial_v152.restaurant_commission_rate': Decimal('0.1500'),
    'commercial_v152.service_fee_rate': Decimal('0.0700'),
    'commercial_v152.base_delivery_fee': Decimal('39.00'),
    'commercial_v152.base_driver_pay': Decimal('32.00'),
    # Policy v1.6.2 only; legacy configurable values stay untouched.
    'commercial_v162.service_fee_rate': Decimal('0.0700'),
    'commercial_v162.service_fee_cap': Decimal('25.00'),
    'commercial_v162.base_delivery_fee': Decimal('35.00'),
    'commercial_v162.included_km': Decimal('2.00'),
    'commercial_v162.additional_per_km': Decimal('5.00'),
    # Repartidor: base $32 (v1.5.2) + $4 por km sobre los primeros 2 km.
    'commercial_v162.driver_additional_per_km': Decimal('4.00'),
}


def money(value) -> Decimal:
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def get_decimal_setting(db: Session, key: str, default: Decimal) -> Decimal:
    row = db.scalar(select(models.SystemSetting).where(models.SystemSetting.key == key))
    if not row:
        return default
    try:
        return Decimal(row.value)
    except Exception:
        return default


def commercial_v152_active() -> bool:
    # Central opt-out preserves the exact v1.5.1 economics for rollback testing.
    from .config import settings
    return settings.commercial_pricing_v152_enabled


def commercial_v162_active() -> bool:
    # New prices require an explicit opt-in and existing commercial policy enabled.
    from .config import settings
    return bool(settings.commercial_pricing_v152_enabled and settings.commercial_pricing_v162_enabled)


def commercial_value(db: Session, name: str, maximum: Decimal) -> Decimal:
    default = DEFAULTS[name]
    value = get_decimal_setting(db, name, default)
    if not value.is_finite() or not Decimal('0') <= value <= maximum:
        return default  # Fail closed against malformed ADMIN settings, incl. NaN/Infinity.
    return value


def effective_delivery_fee(db: Session, restaurant: models.Restaurant, distance_km) -> Decimal:
    from decimal import Decimal
    distance = max(Decimal('0'), Decimal(str(distance_km)))
    original = money(Decimal(restaurant.delivery_fee) + distance * Decimal(restaurant.per_km_fee))
    if commercial_v162_active():
        # v1.6.2 price: $35 includes first 2 km; $5 per additional km.
        # Location is distance computed server-side at order creation.
        base = commercial_value(db, 'commercial_v162.base_delivery_fee', Decimal('10000'))
        included = commercial_value(db, 'commercial_v162.included_km', Decimal('100'))
        extra_per_km = commercial_value(db, 'commercial_v162.additional_per_km', Decimal('1000'))
        return money(base + max(Decimal('0'), distance - included) * extra_per_km)
    if commercial_v152_active():
        base = commercial_value(db, 'commercial_v152.base_delivery_fee', Decimal('10000'))
        return max(base, original)
    return original


def effective_commission_rate(db: Session, restaurant: models.Restaurant) -> Decimal:
    if commercial_v152_active():
        return commercial_value(db, 'commercial_v152.restaurant_commission_rate', Decimal('0.50'))
    if restaurant.commission_rate and Decimal(restaurant.commission_rate) > 0:
        return Decimal(restaurant.commission_rate)
    plan = (restaurant.commercial_plan or 'START').upper()
    key = {
        'START': 'restaurant_commission_start',
        'DELIVERY': 'restaurant_commission_delivery',
        'PRO': 'restaurant_commission_pro',
    }.get(plan, 'restaurant_commission_start')
    return get_decimal_setting(db, key, DEFAULTS[key])


def calculate_order_economics(
    db: Session,
    restaurant: models.Restaurant,
    subtotal: Decimal,
    discount: Decimal,
    delivery_fee: Decimal,
    tip: Decimal,
    payment_method: str,
    promotion_subsidy: Decimal = Decimal('0'),
    merchant_managed_delivery: bool = False,
    order_type: str = 'delivery',
    distance_km: float | Decimal | None = None,
) -> dict[str, Decimal]:
    merchandise = max(Decimal('0'), Decimal(subtotal) - Decimal(discount))
    commission_rate = effective_commission_rate(db, restaurant)
    commission = money(merchandise * commission_rate)

    # v1.5.2: same 7% on NET FOOD in all methods, including cash; excludes
    # shipping and tip. No minimum/fixed fee. Old v1.5.1 mode is opt-out.
    if commercial_v152_active():
        rate_key = 'commercial_v162.service_fee_rate' if commercial_v162_active() else 'commercial_v152.service_fee_rate'
        service_fee = money(merchandise * commercial_value(
            db, rate_key, Decimal('0.25')))
        if commercial_v162_active():
            cap = commercial_value(db, 'commercial_v162.service_fee_cap', Decimal('10000'))
            service_fee = min(service_fee, cap)
    elif payment_method == 'cash':
        service_fee = Decimal('0.00')
    else:
        configured_rate = Decimal(restaurant.service_fee_rate or 0)
        service_rate = configured_rate if configured_rate > 0 else get_decimal_setting(db, 'service_fee_rate', DEFAULTS['service_fee_rate'])
        service_min = get_decimal_setting(db, 'service_fee_min', DEFAULTS['service_fee_min'])
        service_fee = money(max(service_min, merchandise * service_rate) + Decimal(restaurant.service_fee_fixed or 0))

    driver_share = get_decimal_setting(db, 'driver_share_of_delivery_fee', DEFAULTS['driver_share_of_delivery_fee'])
    driver_earning = Decimal('0') if merchant_managed_delivery or order_type != 'delivery' else (money(Decimal(delivery_fee) * driver_share) if Decimal(delivery_fee) > 0 else Decimal('0'))
    if commercial_v152_active() and order_type == 'delivery' and not merchant_managed_delivery:
        base_driver_pay = commercial_value(db, 'commercial_v152.base_driver_pay', Decimal('10000'))
        driver_earning = max(driver_earning, base_driver_pay)
        if commercial_v162_active() and distance_km is not None:
            # El valor proviene de la distancia geográfica calculada en el servidor,
            # no del distance_km proporcionado por el cliente en producción.
            km = Decimal(str(distance_km))
            if not km.is_finite() or km < 0:
                raise ValueError('La distancia del reparto debe ser un número no negativo')
            included_km = commercial_value(db, 'commercial_v162.included_km', Decimal('100'))
            increment = commercial_value(db, 'commercial_v162.driver_additional_per_km', Decimal('100'))
            distance_payout = money(base_driver_pay + max(Decimal('0'), km - included_km) * increment)
            # Nunca rebajar el pago existente calculado por porcentaje o mínimo.
            driver_earning = max(driver_earning, distance_payout)

    processing = Decimal('0')
    if payment_method == 'stripe':
        from .config import settings
        # Configurable separate service fee and estimated gateway expense. These
        # estimates are not a representation of the provider's actual settled fee.
        rate = min(max(Decimal(settings.stripe_service_fee_rate), Decimal('0')), Decimal('0.25'))
        fixed = min(max(Decimal(settings.stripe_service_fee_fixed), Decimal('0')), Decimal('1000'))
        if not commercial_v152_active():
            service_fee = money(max(service_min, merchandise * rate) + fixed)
        gateway_rate = min(max(Decimal(settings.stripe_processing_rate), Decimal('0')), Decimal('0.3'))
        gateway_fixed = min(max(Decimal(settings.stripe_processing_fixed), Decimal('0')), Decimal('1000'))
        gateway_tax = min(max(Decimal(settings.stripe_processing_tax_rate), Decimal('0')), Decimal('1'))
        projected = (merchandise + Decimal(delivery_fee) + Decimal(tip) + service_fee) * gateway_rate + gateway_fixed
        processing = money(projected * (Decimal('1') + gateway_tax))
    elif payment_method == 'mercadopago':
        rate = get_decimal_setting(db, 'payment_processing_rate', DEFAULTS['payment_processing_rate'])
        fixed = get_decimal_setting(db, 'payment_processing_fixed', DEFAULTS['payment_processing_fixed'])
        processing = money((merchandise + Decimal(delivery_fee) + Decimal(tip) + service_fee) * rate + fixed)

    if merchant_managed_delivery:
        restaurant_payout = money(merchandise - commission + Decimal(delivery_fee) + Decimal(tip))
        platform_revenue = money(commission + service_fee)
    else:
        # Pickup tips go to the restaurant; delivery tips go 100% to driver.
        restaurant_payout = money(merchandise - commission + (Decimal(tip) if commercial_v152_active() and order_type == 'pickup' else Decimal('0')))
        delivery_margin = Decimal(delivery_fee) - driver_earning
        if not commercial_v152_active():
            delivery_margin = max(Decimal('0'), delivery_margin)  # legacy semantics
        platform_revenue = money(commission + service_fee + delivery_margin)
    contribution_margin = money(platform_revenue - processing - Decimal(promotion_subsidy))
    total = money(merchandise + Decimal(delivery_fee) + Decimal(tip) + service_fee)

    return {
        'commission_rate': commission_rate,
        'platform_commission': commission,
        'service_fee': service_fee,
        'driver_earning': driver_earning,
        'payment_processing_fee': processing,
        'promotion_subsidy': money(promotion_subsidy),
        'restaurant_payout': restaurant_payout,
        'platform_revenue': platform_revenue,
        'contribution_margin': contribution_margin,
        'total': total,
    }


def post_order_ledger(db: Session, order: models.Order) -> None:
    entries = [
        ('gmv', 'credit', order.total, 'GMV del pedido'),
        ('restaurant_payable', 'credit', order.restaurant_payout, 'Saldo por pagar al restaurante'),
        ('driver_payable', 'credit', money(Decimal(order.driver_earning or 0) + (Decimal(order.tip or 0) if commercial_v152_active() and order.order_type == 'delivery' and Decimal(order.driver_earning or 0) > 0 else Decimal('0'))), 'Saldo al repartidor, propina íntegra incluida'),
        ('platform_revenue', 'credit', order.platform_revenue, 'Ingreso bruto Tala Eats'),
        ('payment_processing', 'debit', order.payment_processing_fee, 'Costo pasarela de pago'),
        ('promotion_subsidy', 'debit', order.promotion_subsidy, 'Subsidio promocional Tala Eats'),
        ('contribution_margin', 'credit', order.contribution_margin, 'Margen de contribución estimado'),
    ]
    for account, direction, amount, description in entries:
        amount = Decimal(amount or 0)
        if amount < 0:
            amount, direction = -amount, ('debit' if direction == 'credit' else 'credit')
        if amount == 0:
            continue
        post_ledger_entry(
            db,
            idempotency_key=f'order:{order.id}:ledger:{account}',
            account=account,
            direction=direction,
            amount=amount,
            kind='order_settlement',
            description=description,
            order=order,
            user_id=order.driver_id if account == 'driver_payable' else order.user_id,
            restaurant_id=order.restaurant_id,
        )


def post_ledger_entry(
    db: Session,
    *,
    idempotency_key: str,
    account: str,
    direction: str,
    amount: Decimal,
    kind: str,
    description: str,
    order: models.Order | None = None,
    user_id: int | None = None,
    restaurant_id: int | None = None,
) -> models.FinancialLedgerEntry | None:
    """Append one immutable financial movement.

    Corrections are represented as new compensating rows. Production PostgreSQL
    also has a trigger that rejects UPDATE/DELETE on this table.
    """
    value = money(amount)
    if value == 0:
        return None
    key = idempotency_key[:180]
    # SessionLocal intentionally runs with autoflush=False. Check pending ORM rows
    # before the database so two calls in the same transaction cannot enqueue the
    # same immutable movement twice. The UNIQUE constraint remains the final guard
    # across concurrent transactions.
    for pending in db.new:
        if isinstance(pending, models.FinancialLedgerEntry) and pending.idempotency_key == key:
            return pending
    exists = db.scalar(select(models.FinancialLedgerEntry.id).where(models.FinancialLedgerEntry.idempotency_key == key))
    if exists:
        return db.get(models.FinancialLedgerEntry, exists)
    row = models.FinancialLedgerEntry(
        order_id=order.id if order else None,
        user_id=user_id if user_id is not None else (order.user_id if order else None),
        restaurant_id=restaurant_id if restaurant_id is not None else (order.restaurant_id if order else None),
        account=account[:60],
        direction=direction,
        amount=value,
        kind=kind[:60],
        description=description[:300],
        idempotency_key=key,
    )
    db.add(row)
    return row


def post_refund_ledger(db: Session, order: models.Order, amount: Decimal, *, idempotency_suffix: str = "full") -> None:
    """Append compensating entries for a refund; safe under retries."""
    value = money(amount)
    if value <= 0:
        return
    base = f"order:{order.id}:refund:{idempotency_suffix}"
    post_ledger_entry(db, idempotency_key=f"{base}:gmv", account="gmv", direction="debit", amount=value,
                      kind="refund", description="Reverso de GMV por reembolso", order=order)
    # The exact settlement split may be reconciled later by provider/payout rules;
    # this receivable is the canonical cash movement at refund time.
    post_ledger_entry(db, idempotency_key=f"{base}:customer", account="customer_refund_payable", direction="credit", amount=value,
                      kind="refund", description="Monto reembolsable al cliente", order=order)
