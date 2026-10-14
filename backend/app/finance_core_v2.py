"""Finance Core V2: isolated, append-only shadow booking (NO actual money movement).

The existing pricing engine is authoritative. This module consumes immutable
order snapshots; it does not change prices, issue refunds, touch Stripe or run
payouts. A bank receivable is NOT bank cash.

Execution requires FINANCE_V2_SHADOW_ENABLED=true and is intentionally off in
all existing environments. API exposure and payout availability remain gated.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models

CENT = Decimal("0.01")
MAX_CENTS = 9_000_000_000_000_000
CASH_DEBT_LIMIT_CENTS = 50_000  # proposed $500 MXN, NOT enforcement in prod


class FinanceV2Error(ValueError):
    """Fail closed if accounting is not provably balanced."""


def cents(value: object) -> int:
    """Strict Decimal money, never float arithmetic; reject fractional cents."""
    if isinstance(value, float):
        raise FinanceV2Error("No se aceptan floats en importes monetarios")
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise FinanceV2Error("Importe no numérico") from exc
    if not amount.is_finite() or amount != amount.quantize(CENT, rounding=ROUND_HALF_UP):
        raise FinanceV2Error("Importe no finito o con fracciones de centavo")
    count = int(amount * 100)
    if abs(count) > MAX_CENTS:
        raise FinanceV2Error("Importe fuera de límite")
    return count


@dataclass(frozen=True)
class FinanceV2Snapshot:
    order_id: int
    restaurant_id: int
    driver_id: int | None
    payment_method: str
    order_type: str
    total: int
    subtotal: int
    discount: int
    delivery_fee: int
    service_fee: int
    tip: int
    commission: int
    restaurant_payable: int
    driver_payable: int
    platform_revenue: int
    collector_type: str | None
    collector_id: int | None

    @property
    def is_cash(self) -> bool:
        return self.payment_method == "cash"

    @property
    def cash_due_from_collector(self) -> int:
        if not self.is_cash:
            return 0
        retained = self.driver_payable if self.collector_type == "driver" else self.restaurant_payable
        return max(0, self.total - retained)

    @property
    def balanced(self) -> bool:
        return self.total == self.restaurant_payable + self.driver_payable + self.platform_revenue


def snapshot_from_order(order: models.Order) -> FinanceV2Snapshot:
    if not isinstance(order.id, int) or order.id <= 0:
        raise FinanceV2Error("Pedido sin ID persistido")
    if order.status != "delivered" or order.payment_status != "paid":
        raise FinanceV2Error("Solo conciliar pedido entregado y pago confirmado")
    if cents(order.refunded_amount or Decimal("0")) != 0:
        raise FinanceV2Error("Reembolsos requieren asiento compensatorio separado")
    if cents(order.promotion_subsidy or Decimal("0")):
        # Legacy coupons may discount the merchant instead of the platform.
        # Do not silently promise the merchant full pre-discount revenue.
        raise FinanceV2Error("Cupón subsidiado requiere política de financiación aprobada")
    method = str(order.payment_method or "").strip().lower()
    if method not in {"cash", "stripe", "mercadopago"}:
        raise FinanceV2Error("Método de pago no conciliable")
    kind = str(order.order_type or "delivery")
    if kind not in {"delivery", "pickup"}:
        raise FinanceV2Error("Tipo de entrega no compatible")
    restaurant_id = int(order.restaurant_id or 0)
    if restaurant_id <= 0:
        raise FinanceV2Error("Restaurante inválido")

    subtotal = cents(order.subtotal)
    discount = cents(order.discount)
    shipping = cents(order.delivery_fee)
    service_fee = cents(order.service_fee)
    tip = cents(order.tip)
    total = cents(order.total)
    commission = cents(order.platform_commission)
    merchant = cents(order.restaurant_payout)
    driver_earning = cents(order.driver_earning)
    platform = cents(order.platform_revenue)
    if min(subtotal, discount, shipping, service_fee, tip, total, commission, merchant, driver_earning) < 0:
        raise FinanceV2Error("Componentes negativos no autorizados")
    if discount > subtotal or commission > subtotal - discount:
        raise FinanceV2Error("Comisión/descuento superior a alimentos netos")
    if total != subtotal - discount + shipping + service_fee + tip:
        raise FinanceV2Error("El total no coincide con su desglose")
    if kind == "pickup" and (driver_earning != 0 or shipping != 0):
        raise FinanceV2Error("Recoger no debe pagar repartidor ni envío")
    driver_id = int(order.driver_id) if order.driver_id else None
    if kind == "delivery" and driver_earning and not driver_id:
        raise FinanceV2Error("Pago a repartidor sin repartidor asignado")

    # Pickup tip is part of merchant_payout in the existing pricing engine.
    driver_payable = driver_earning + (tip if kind == "delivery" and driver_earning else 0)
    if merchant + driver_payable + platform != total:
        raise FinanceV2Error("Invariante de reparto no balanceada")

    collector_type: str | None = None
    collector_id: int | None = None
    if method == "cash":
        collector_type = "restaurant" if kind == "pickup" or not driver_id else "driver"
        collector_id = restaurant_id if collector_type == "restaurant" else driver_id
    return FinanceV2Snapshot(
        order_id=order.id, restaurant_id=restaurant_id, driver_id=driver_id,
        payment_method=method, order_type=kind, total=total,
        subtotal=subtotal, discount=discount, delivery_fee=shipping,
        service_fee=service_fee, tip=tip, commission=commission,
        restaurant_payable=merchant, driver_payable=driver_payable,
        platform_revenue=platform, collector_type=collector_type,
        collector_id=collector_id,
    )


@dataclass(frozen=True)
class JournalLine:
    account: str
    direction: str
    amount: int
    owner_type: str | None = None
    owner_id: int | None = None


def balanced_lines(s: FinanceV2Snapshot) -> list[JournalLine]:
    receiver = ("cash_collector_receivable" if s.is_cash else "processor_receivable")
    lines = [JournalLine(receiver, "debit", s.total, s.collector_type, s.collector_id)]
    if s.restaurant_payable:
        lines.append(JournalLine("restaurant_payable", "credit", s.restaurant_payable, "restaurant", s.restaurant_id))
    if s.driver_payable:
        lines.append(JournalLine("driver_payable", "credit", s.driver_payable, "driver", s.driver_id))
    if s.platform_revenue > 0:
        lines.append(JournalLine("platform_revenue_accrued", "credit", s.platform_revenue))
    elif s.platform_revenue < 0:
        lines.append(JournalLine("platform_delivery_loss", "debit", -s.platform_revenue))
    lines = [line for line in lines if line.amount]
    debit = sum(x.amount for x in lines if x.direction == "debit")
    credit = sum(x.amount for x in lines if x.direction == "credit")
    if debit != credit:
        raise FinanceV2Error(f"Asiento desequilibrado: {debit} vs {credit}")
    return lines


def wallet_deltas(s: FinanceV2Snapshot) -> dict[tuple[str, int], tuple[int, int, int]]:
    """(signed balance change, unverified positive funds, cash exposure).

    Pending credits are NOT withdrawable: Stripe processing != bank settlement,
    and cash in a driver's hands != Tala Eats' bank deposits.
    """
    entries: dict[tuple[str, int], tuple[int, int, int]] = {}

    def add(role: str, owner_id: int, balance: int, unfunded: int, exposure: int) -> None:
        key = (role, owner_id)
        a, b, c = entries.get(key, (0, 0, 0))
        entries[key] = a + balance, b + unfunded, c + exposure

    add("restaurant", s.restaurant_id, s.restaurant_payable, s.restaurant_payable, 0)
    if s.driver_id and s.driver_payable:
        add("driver", s.driver_id, s.driver_payable, s.driver_payable, 0)
    if s.is_cash:
        if not s.collector_type or not s.collector_id:
            raise FinanceV2Error("Cobro cash sin custodio")
        add(s.collector_type, s.collector_id, -s.total, 0, s.cash_due_from_collector)
    return entries


def book_delivered_order(db: Session, order: models.Order) -> models.FinanceV2Journal:
    """Append ONE journal and atomic wallet deltas in caller's DB transaction.

    Does not commit: delivery status and booking must succeed or roll back
    together. UNIQUE(order_id,event_type) is the final concurrency barrier.
    """
    s = snapshot_from_order(order)
    for pending in db.new:
        if (isinstance(pending, models.FinanceV2Journal) and
                pending.order_id == s.order_id and pending.event_type == "delivered"):
            return pending
    existing = db.scalar(select(models.FinanceV2Journal).where(
        models.FinanceV2Journal.order_id == s.order_id,
        models.FinanceV2Journal.event_type == "delivered",
    ))
    if existing is not None:
        return existing
    lines = balanced_lines(s)
    deltas = wallet_deltas(s)

    journal = models.FinanceV2Journal(
        order_id=s.order_id, event_type="delivered", payment_method=s.payment_method,
        total_cents=s.total, platform_revenue_cents=s.platform_revenue,
    )
    db.add(journal)
    db.flush()
    for i, line in enumerate(lines, 1):
        db.add(models.FinanceV2JournalLine(
            journal_id=journal.id, seq=i, account=line.account,
            direction=line.direction, amount_cents=line.amount,
            owner_type=line.owner_type, owner_id=line.owner_id,
        ))
    for (role, owner_id), (balance, unfunded, exposure) in deltas.items():
        current = db.scalar(select(models.FinanceV2Wallet).where(
            models.FinanceV2Wallet.owner_type == role,
            models.FinanceV2Wallet.owner_id == owner_id,
        ).with_for_update())
        if current is None:
            current = models.FinanceV2Wallet(
                owner_type=role, owner_id=owner_id,
                balance_cents=0, unfunded_cents=0, cash_exposure_cents=0,
            )
            db.add(current)
            db.flush()
        current.balance_cents += balance
        current.unfunded_cents += unfunded
        current.cash_exposure_cents += exposure
        db.add(models.FinanceV2WalletMovement(
            journal_id=journal.id, owner_type=role, owner_id=owner_id,
            amount_cents=balance, unfunded_delta_cents=unfunded,
            cash_exposure_delta_cents=exposure,
        ))
    if s.is_cash:
        db.add(models.FinanceV2CashAllocation(
            order_id=s.order_id, journal_id=journal.id,
            collector_type=s.collector_type, collector_id=s.collector_id,
            received_cash_cents=s.total, owed_by_collector_cents=s.cash_due_from_collector,
            status="recorded",
        ))
    # No payouts, credits to bank or debt collections here.
    return journal


def wallet_preview(db: Session, role: str, owner_id: int) -> dict[str, int | str | bool]:
    if role not in {"restaurant", "driver"} or owner_id <= 0:
        raise FinanceV2Error("Beneficiario inválido")
    row = db.scalar(select(models.FinanceV2Wallet).where(
        models.FinanceV2Wallet.owner_type == role, models.FinanceV2Wallet.owner_id == owner_id))
    if row is None:
        balance = held = exposure = 0
    else:
        balance = row.balance_cents
        held = row.unfunded_cents
        exposure = row.cash_exposure_cents
    # Shadow ledger MUST NOT be used to authorize payouts. This preview
    # exposes no 'available for transfer' amount until bank reconciliation exists.
    return {
        "owner_type": role, "owner_id": owner_id,
        "balance_cents": balance, "unverified_receivables_cents": held,
        "cash_exposure_cents": exposure,
        "available_for_payout_cents": 0, "automatic_debt_hold_suggested":
            role == "driver" and balance < -CASH_DEBT_LIMIT_CENTS,
        "shadow_only": True,
    }
