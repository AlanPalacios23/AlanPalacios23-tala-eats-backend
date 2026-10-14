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
    if not amount.is_finite():
        raise FinanceV2Error("Importe no finito")
    # Evaluate magnitude before quantize: Decimal('1e100').quantize('0.01')
    # raises InvalidOperation with the default context precision.
    if abs(amount) > Decimal(MAX_CENTS) / 100:
        raise FinanceV2Error("Importe fuera de límite")
    try:
        rounded = amount.quantize(CENT, rounding=ROUND_HALF_UP)
    except InvalidOperation as exc:
        raise FinanceV2Error("Importe monetario inválido") from exc
    if amount != rounded:
        raise FinanceV2Error("Importe con fracciones de centavo")
    count = int(rounded * 100)
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


def indicative_vat_split(
    s: FinanceV2Snapshot, *, vat_included: bool = True,
    rate: Decimal = Decimal("0.16"),
) -> dict[str, int | str | bool]:
    """Only a tax preview, NOT a CFDI, payable or withholding.

    A gross fee with VAT already included uses rate/(1+rate), not 16% of gross.
    A tax specialist must approve whether this interpretation applies to each
    participant, service and fiscal regime before issuing real invoices.
    """
    if not rate.is_finite() or rate < 0 or rate > Decimal("1"):
        raise FinanceV2Error("Tasa IVA fuera de límites")
    taxable_gross = s.service_fee + s.commission
    tax_decimal = Decimal(taxable_gross) * (rate / (Decimal("1") + rate) if vat_included else rate)
    tax_cents = int(tax_decimal.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return {
        "service_and_commission_cents": taxable_gross,
        "indicative_vat_cents": tax_cents,
        "tax_base_cents": taxable_gross - tax_cents if vat_included else taxable_gross,
        "vat_included": vat_included,
        "rate": str(rate),
        "legal_review_required": True,
    }


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
            role == "driver" and exposure >= CASH_DEBT_LIMIT_CENTS,
        "shadow_only": True,
    }


def driver_cash_eligible(db: Session, driver_id: int, order: models.Order) -> bool:
    """Conservative $500 MXN exposure gate for NEW cash offers only.

    Called behind the OFF-by-default shadow flag. Balances from Stripe pending
    credits do not erase physical custody debt. No existing delivery is blocked.
    """
    if str(order.payment_method or "") != "cash":
        return True
    if driver_id <= 0 or order.order_type != "delivery":
        return False
    due = max(0, cents(order.total) - cents(order.driver_earning) - cents(order.tip))
    wallet = db.scalar(select(models.FinanceV2Wallet).where(
        models.FinanceV2Wallet.owner_type == "driver",
        models.FinanceV2Wallet.owner_id == driver_id,
    ).with_for_update())
    current = int(wallet.cash_exposure_cents) if wallet else 0
    return current + due <= CASH_DEBT_LIMIT_CENTS


def netting_preview(db: Session, role: str, owner_id: int, *,
                    hypothetical_untransferred_cents: int = 0) -> dict:
    """What-if ONLY. Caller input is NOT bank proof and NEVER triggers a debit."""
    if (not isinstance(hypothetical_untransferred_cents, int)
            or isinstance(hypothetical_untransferred_cents, bool)
            or not 0 <= hypothetical_untransferred_cents <= MAX_CENTS):
        raise FinanceV2Error("Importe hipotético inválido")
    view = wallet_preview(db, role, owner_id)
    debt = int(view["cash_exposure_cents"])
    proposed = min(debt, hypothetical_untransferred_cents)
    return {
        "owner_type": role, "owner_id": owner_id,
        "cash_receivable_cents": debt,
        "hypothetical_untransferred_cents": hypothetical_untransferred_cents,
        "hypothetical_netting_cents": proposed,
        "cash_still_unrecovered_cents": debt - proposed,
        "executed_netting_cents": 0, "bank_verified_cents": 0,
        "shadow_only": True, "requires_bank_and_psp_proof": True,
    }


def audit_shadow_integrity(db: Session, *, max_records: int = 2000) -> dict:
    """Audit double-entry sums and wallet projections. Truncation is a FAIL."""
    if not isinstance(max_records, int) or not 1 <= max_records <= 10000:
        raise FinanceV2Error("Límite de auditoría inválido")
    q = max_records + 1
    journals = db.scalars(select(models.FinanceV2Journal).order_by(
        models.FinanceV2Journal.id).limit(q)).all()
    movements = db.scalars(select(models.FinanceV2WalletMovement).order_by(
        models.FinanceV2WalletMovement.id).limit(q)).all()
    wallets = db.scalars(select(models.FinanceV2Wallet).order_by(
        models.FinanceV2Wallet.id).limit(q)).all()
    cash_rows = db.scalars(select(models.FinanceV2CashAllocation).order_by(
        models.FinanceV2CashAllocation.id).limit(q)).all()
    overflow = any(len(group) > max_records for group in
                   (journals, movements, wallets, cash_rows))
    journals, movements, wallets, cash_rows = (
        [a[:max_records] for a in (journals, movements, wallets, cash_rows)])
    errors: list[str] = []
    by_id = {j.id: j for j in journals}
    for journal in journals:
        lines = db.scalars(select(models.FinanceV2JournalLine).where(
            models.FinanceV2JournalLine.journal_id == journal.id)).all()
        if not lines:
            errors.append(f"journal:{journal.id}:missing_lines")
        debit = sum(x.amount_cents for x in lines if x.direction == "debit")
        credit = sum(x.amount_cents for x in lines if x.direction == "credit")
        if (debit != credit or any(x.amount_cents <= 0 or
                                  x.direction not in {"debit", "credit"}
                                  for x in lines)):
            errors.append(f"journal:{journal.id}:unbalanced")
    summary = {}
    for m in movements:
        if m.journal_id not in by_id and not overflow:
            errors.append(f"movement:{m.id}:orphan")
        key = (m.owner_type, m.owner_id)
        total = summary.setdefault(key, [0, 0, 0])
        total[0] += m.amount_cents
        total[1] += m.unfunded_delta_cents
        total[2] += m.cash_exposure_delta_cents
    wallet_keys = set()
    for w in wallets:
        key = (w.owner_type, w.owner_id)
        wallet_keys.add(key)
        real = [w.balance_cents, w.unfunded_cents, w.cash_exposure_cents]
        if not overflow and real != summary.get(key, [0, 0, 0]):
            errors.append(f"wallet:{w.owner_type}:{w.owner_id}:projection_mismatch")
        if w.cash_exposure_cents < 0 or w.unfunded_cents < 0:
            errors.append(f"wallet:{w.owner_type}:{w.owner_id}:negative_hold")
    if not overflow:
        for role, owner_id in summary.keys() - wallet_keys:
            errors.append(f"wallet:{role}:{owner_id}:missing")
    for row in cash_rows:
        journal = by_id.get(row.journal_id)
        if journal is None and not overflow:
            errors.append(f"cash:{row.id}:orphan")
        elif journal is not None and (journal.order_id != row.order_id or
                                     journal.payment_method != "cash" or
                                     row.received_cash_cents != journal.total_cents):
            errors.append(f"cash:{row.id}:invalid")
    if overflow:
        errors.append("limit_exceeded:full_scan_required")
    return {
        "ok": not errors, "violations": errors[:100],
        "checked_journals": len(journals),
        "checked_movements": len(movements),
        "checked_wallets": len(wallets),
        "checked_cash_allocations": len(cash_rows),
        "shadow_only": True, "bank_reconciliation_verified": False,
    }
