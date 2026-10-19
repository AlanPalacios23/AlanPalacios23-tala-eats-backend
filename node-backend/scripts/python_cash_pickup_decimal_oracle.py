#!/usr/bin/env python3
"""Python Decimal oracle for a restricted cash/pickup Node stage slice.

Reference: backend/app/monetization.py:money/calculate_order_economics,
and backend/app/routes/orders.py:cancel/cancellation_preview.
This intentionally replays *the Python arithmetic*, using CPython's real
Decimal/ROUND_HALF_UP and default HALF_EVEN; no DB, network, app imports,
secrets or production changes. C1's synthetic cash/pickup only.
The oracle DOES NOT validate configurable SystemSetting/plus/PSP or all Python.
"""
from decimal import Decimal, ROUND_HALF_UP, ROUND_HALF_EVEN
import json
import sys

CENT = Decimal("0.01")

def money(n):
    return n.quantize(CENT, rounding=ROUND_HALF_UP)

def calculate(v):
    subtotal = Decimal(v["subtotal"])
    tip = Decimal(v.get("tip", "0"))
    commission = money(subtotal * Decimal("0.15"))
    fee = money(subtotal * Decimal("0.07"))
    payout = money(subtotal - commission + tip)
    revenue = money(commission + fee)
    total = money(subtotal + fee + tip)
    # orders.py cancel uses quantize CENT WITHOUT ROUND_HALF_UP;
    # Python decimal context defaults to ROUND_HALF_EVEN.
    cancel_confirmed = (subtotal * Decimal("0.10")).quantize(
        CENT, rounding=ROUND_HALF_EVEN)
    cancel_preparing = (subtotal * Decimal("0.30")).quantize(
        CENT, rounding=ROUND_HALF_EVEN)
    return {
        "subtotal":str(money(subtotal)),
        "tip":str(money(tip)),
        "platform_commission":str(commission),
        "service_fee":str(fee),
        "restaurant_payout":str(payout),
        "platform_revenue":str(revenue),
        "contribution_margin":str(revenue),
        "total":str(total),
        "cancellation_confirmed":str(cancel_confirmed),
        "cancellation_preparing":str(cancel_preparing),
    }

def main():
    v = json.load(sys.stdin)
    if not isinstance(v,list) or not (1 <= len(v) <= 200):
        raise ValueError("Expected 1..200 cases")
    print(json.dumps([calculate(x) for x in v],separators=(",",":")))

if __name__=="__main__":
    main()
