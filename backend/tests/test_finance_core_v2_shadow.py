"""Finance V2 shadow: never calls Stripe, transfers, provider or live server."""
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app import models
from app.db import Base
from app.finance_core_v2 import (
    FinanceV2Error, balanced_lines, book_delivered_order, cents,
    audit_shadow_integrity, driver_cash_eligible, indicative_vat_split,
    netting_preview, snapshot_from_order, wallet_preview,
)


def order_sample(id=1, *, method="cash", order_type="delivery", tip="0.00",
                 driver_id=4, status="delivered", payment_status="paid",
                 refund="0.00", subsidized="0.00"):
    # Existing v1.6.2 prices: $200 food, $35 delivery, $14 service, $30 commission,
    # $32 driver. Promo subsidies are separate and cannot silently shift merchant dues.
    shipping = Decimal("0.00") if order_type == "pickup" else Decimal("35.00")
    service = Decimal("14.00")
    gratuity = Decimal(tip)
    subtotal = Decimal("200.00")
    platform = Decimal("44.00") if order_type == "pickup" else Decimal("47.00")
    return models.Order(
        id=id, user_id=1, restaurant_id=2, driver_id=driver_id if order_type == "delivery" else None,
        status=status, payment_method=method, payment_status=payment_status,
        subtotal=subtotal, discount=Decimal("0.00"),
        delivery_fee=shipping, tip=gratuity, service_fee=service,
        platform_commission=Decimal("30.00"),
        restaurant_payout=Decimal("170.00") + (gratuity if order_type == "pickup" else Decimal("0.00")),
        driver_earning=Decimal("32.00") if order_type == "delivery" else Decimal("0.00"),
        platform_revenue=platform,
        payment_processing_fee=Decimal("0.00"),
        promotion_subsidy=Decimal(subsidized), refunded_amount=Decimal(refund),
        total=subtotal + shipping + service + gratuity,
        order_type=order_type, address="Tala Jalisco",
    )


@pytest.fixture
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine, autoflush=False, expire_on_commit=False) as db:
        yield db
        db.rollback()
    engine.dispose()


def test_decimal_is_strict_and_never_uses_floating_point():
    assert cents(Decimal("249.00")) == 24900
    for value in ("0.001", "NaN", "Infinity", "1e100", 0.1):
        with pytest.raises(FinanceV2Error):
            cents(value)


def test_cash_delivery_balances_exactly_and_negative_wallet(session):
    order = order_sample()
    session.add(order)
    session.flush()
    snap = snapshot_from_order(order)
    assert snap.total == 24900
    assert snap.restaurant_payable == 17000
    assert snap.driver_payable == 3200
    assert snap.platform_revenue == 4700
    assert snap.cash_due_from_collector == 21700
    journal = book_delivered_order(session, order)
    session.commit()
    rows = session.scalars(select(models.FinanceV2JournalLine).where(
        models.FinanceV2JournalLine.journal_id == journal.id)).all()
    assert sum(r.amount_cents for r in rows if r.direction == "debit") == 24900
    assert sum(r.amount_cents for r in rows if r.direction == "credit") == 24900
    assert session.scalar(select(models.FinanceV2CashAllocation)).collector_type == "driver"
    assert session.scalar(select(models.FinanceV2CashAllocation)).owed_by_collector_cents == 21700
    driver = wallet_preview(session, "driver", 4)
    merchant = wallet_preview(session, "restaurant", 2)
    assert driver["balance_cents"] == -21700
    assert driver["cash_exposure_cents"] == 21700
    assert merchant["balance_cents"] == 17000
    assert merchant["unverified_receivables_cents"] == 17000
    assert driver["available_for_payout_cents"] == merchant["available_for_payout_cents"] == 0


def test_cash_pickup_cash_is_with_restaurant_not_driver(session):
    order = order_sample(2, order_type="pickup")
    session.add(order)
    session.flush()
    book_delivered_order(session, order)
    session.commit()
    alloc = session.scalar(select(models.FinanceV2CashAllocation))
    assert alloc.collector_type == "restaurant"
    assert alloc.received_cash_cents == 21400
    assert alloc.owed_by_collector_cents == 4400
    assert wallet_preview(session, "restaurant", 2)["balance_cents"] == -4400
    assert wallet_preview(session, "driver", 4)["balance_cents"] == 0


@pytest.mark.parametrize("method", ["stripe", "mercadopago"])
def test_digital_captured_does_not_claim_bank_cash(session, method):
    order = order_sample(3, method=method)
    session.add(order)
    session.flush()
    journal = book_delivered_order(session, order)
    session.commit()
    assert session.scalar(select(models.FinanceV2CashAllocation)) is None
    row = session.scalar(select(models.FinanceV2JournalLine).where(
        models.FinanceV2JournalLine.journal_id == journal.id,
        models.FinanceV2JournalLine.account == "processor_receivable"))
    assert row.amount_cents == 24900
    assert wallet_preview(session, "driver", 4)["balance_cents"] == 3200
    assert wallet_preview(session, "restaurant", 2)["balance_cents"] == 17000
    assert wallet_preview(session, "driver", 4)["available_for_payout_cents"] == 0


def test_tip_is_in_full_driver_share_and_not_double_counted(session):
    order = order_sample(4, tip="20.00")
    session.add(order)
    session.flush()
    snap = snapshot_from_order(order)
    assert snap.total == 26900
    assert snap.driver_payable == 5200
    assert snap.cash_due_from_collector == 21700
    assert snap.balanced
    book_delivered_order(session, order)
    session.commit()
    assert wallet_preview(session, "driver", 4)["balance_cents"] == -21700


def test_repeated_booking_same_order_does_not_double_credit(session):
    order = order_sample()
    session.add(order)
    session.flush()
    first = book_delivered_order(session, order)
    again = book_delivered_order(session, order)
    assert first is again
    session.commit()
    third = book_delivered_order(session, order)
    assert third.id == first.id
    session.commit()
    assert len(session.scalars(select(models.FinanceV2Journal)).all()) == 1
    assert len(session.scalars(select(models.FinanceV2WalletMovement)).all()) == 2
    assert wallet_preview(session, "driver", 4)["balance_cents"] == -21700


@pytest.mark.parametrize("changes", [
    {"status": "cancelled"},
    {"payment_status": "pending"},
    {"refunded_amount": Decimal("10.00")},
    {"promotion_subsidy": Decimal("50.00")},
    {"total": Decimal("250.00")},
    {"restaurant_payout": Decimal("200.00")},
])
def test_unsafe_or_inconsistent_orders_fail_closed(changes):
    order = order_sample()
    for name, value in changes.items():
        setattr(order, name, value)
    with pytest.raises(FinanceV2Error):
        snapshot_from_order(order)


def test_roll_back_financial_changes_with_order_transaction(session):
    order = order_sample()
    session.add(order)
    session.flush()
    book_delivered_order(session, order)
    session.rollback()
    assert session.scalar(select(models.FinanceV2Journal)) is None
    assert session.scalar(select(models.FinanceV2Wallet)) is None
    assert session.scalar(select(models.FinanceV2CashAllocation)) is None


def test_debt_gate_preserves_digital_offers_and_limits_new_cash(session):
    first = order_sample()
    session.add(first)
    session.flush()
    assert driver_cash_eligible(session, 4, first) is True
    book_delivered_order(session, first)
    session.commit()
    next_order = order_sample(5)
    assert driver_cash_eligible(session, 4, next_order) is True
    session.add(next_order)
    session.flush()
    book_delivered_order(session, next_order)
    session.commit()
    third_cash = order_sample(6)
    assert driver_cash_eligible(session, 4, third_cash) is False
    digital = order_sample(7, method="stripe")
    assert driver_cash_eligible(session, 4, digital) is True


def test_wallet_preview_never_exposes_other_roles_or_payable_bank_funds(session):
    with pytest.raises(FinanceV2Error):
        wallet_preview(session, "customer", 12)
    assert wallet_preview(session, "restaurant", 999)["available_for_payout_cents"] == 0
    assert wallet_preview(session, "restaurant", 999)["shadow_only"] is True


def test_vat_preview_16_percent_is_not_double_charged():
    s = snapshot_from_order(order_sample())
    inclusive = indicative_vat_split(s)
    excluded = indicative_vat_split(s, vat_included=False)
    # $14 service + $30 merchant commission = $44 gross.
    assert inclusive["service_and_commission_cents"] == 4400
    assert inclusive["indicative_vat_cents"] == 607
    assert inclusive["tax_base_cents"] == 3793
    assert excluded["indicative_vat_cents"] == 704
    assert inclusive["legal_review_required"]


def test_shadow_audit_balances_cash_and_digital(session):
    for order in [order_sample(1), order_sample(2, method="stripe")]:
        session.add(order)
        session.flush()
        book_delivered_order(session, order)
    session.commit()
    audit = audit_shadow_integrity(session)
    assert audit["ok"] is True
    assert audit["checked_journals"] == 2
    assert audit["bank_reconciliation_verified"] is False


def test_shadow_audit_detects_tampering(session):
    order = order_sample()
    session.add(order)
    session.flush()
    book_delivered_order(session, order)
    session.commit()
    wallet = session.scalar(select(models.FinanceV2Wallet).where(
        models.FinanceV2Wallet.owner_type == "driver"))
    wallet.balance_cents += 1
    session.commit()
    audit = audit_shadow_integrity(session)
    assert not audit["ok"]
    assert any("projection_mismatch" in x for x in audit["violations"])


def test_shadow_audit_incomplete_scan_is_never_pass(session):
    for order in [order_sample(1), order_sample(2, method="stripe")]:
        session.add(order)
        session.flush()
        book_delivered_order(session, order)
    session.commit()
    audit = audit_shadow_integrity(session, max_records=1)
    assert audit["ok"] is False
    assert "limit_exceeded:full_scan_required" in audit["violations"]


def test_shadow_netting_cannot_fake_a_real_recovery(session):
    for order in [order_sample(1), order_sample(2, method="stripe")]:
        session.add(order)
        session.flush()
        book_delivered_order(session, order)
    session.commit()
    result = netting_preview(session, "driver", 4)
    assert result["cash_receivable_cents"] == 21700
    assert result["executed_netting_cents"] == result["bank_verified_cents"] == 0
    hypothetical = netting_preview(session, "driver", 4,
                                    hypothetical_untransferred_cents=3200)
    assert hypothetical["hypothetical_netting_cents"] == 3200
    assert hypothetical["cash_still_unrecovered_cents"] == 18500
    assert wallet_preview(session, "driver", 4)["cash_exposure_cents"] == 21700


@pytest.mark.parametrize("amount", [-1, True, 0.25, 10**30])
def test_shadow_netting_rejects_bad_external_amount(session, amount):
    with pytest.raises(FinanceV2Error):
        netting_preview(session, "driver", 4,
                        hypothetical_untransferred_cents=amount)


def test_stripe_withdrawal_hold_applies_to_unrecovered_cash(session, monkeypatch):
    from fastapi import HTTPException
    from app.config import settings
    from app.routes.withdrawals import _legacy_holds

    cash = order_sample(41)
    session.add(cash)
    session.flush()
    book_delivered_order(session, cash)
    session.commit()

    monkeypatch.setattr(settings, "finance_v2_shadow_enabled", True)
    with pytest.raises(HTTPException) as exc:
        _legacy_holds(session, "driver", 4)
    assert exc.value.status_code == 409
    assert "efectivo" in str(exc.value.detail).lower()

    # The existing production flow is unaffected with the feature disabled.
    monkeypatch.setattr(settings, "finance_v2_shadow_enabled", False)
    _legacy_holds(session, "driver", 4)


def test_stripe_withdrawal_hold_covers_restaurant_cash_pickup(session, monkeypatch):
    from fastapi import HTTPException
    from app.config import settings
    from app.routes.withdrawals import _legacy_holds

    cash = order_sample(42, order_type="pickup")
    session.add(cash)
    session.flush()
    book_delivered_order(session, cash)
    session.commit()

    monkeypatch.setattr(settings, "finance_v2_shadow_enabled", True)
    with pytest.raises(HTTPException) as exc:
        _legacy_holds(session, "restaurant", 2)
    assert exc.value.status_code == 409
    assert wallet_preview(session, "restaurant", 2)["cash_exposure_cents"] == 4400
