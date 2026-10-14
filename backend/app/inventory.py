from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Iterable
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models


def _legacy_ingredient_usage(db: Session, order: models.Order) -> dict[int, Decimal]:
    """Best-effort reconstruction for orders created before inventory snapshots existed."""
    quantities: dict[int, int] = defaultdict(int)
    for line in order.items:
        if line.menu_item_id and line.quantity > 0:
            quantities[int(line.menu_item_id)] += int(line.quantity)
    if not quantities:
        return {}
    recipes = db.scalars(
        select(models.MenuRecipe).where(models.MenuRecipe.menu_item_id.in_(sorted(quantities)))
    ).all()
    usage: dict[int, Decimal] = defaultdict(Decimal)
    for recipe in recipes:
        usage[int(recipe.ingredient_id)] += Decimal(recipe.quantity_required) * quantities[int(recipe.menu_item_id)]
    return dict(usage)


def _ingredient_usage(db: Session, order: models.Order) -> dict[int, Decimal]:
    # New orders snapshot exact ingredient reservations at checkout so later recipe
    # edits cannot corrupt a cancellation/refund. Legacy rows fall back to recipes.
    raw = order.inventory_reserved_json or "{}"
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            result = {
                int(key): Decimal(str(value))
                for key, value in parsed.items()
                if Decimal(str(value)) > 0
            }
            if result:
                return result
    except (ValueError, TypeError, json.JSONDecodeError):
        pass
    return _legacy_ingredient_usage(db, order)


def restore_orders_inventory(db: Session, orders: Iterable[models.Order]) -> int:
    """Restore reserved menu and ingredient stock exactly once for many orders.

    Callers should hold/serialize each order row before invoking this function.
    Stock rows are locked in deterministic primary-key order. The
    ``inventory_restored_at`` marker is written in the same DB transaction as the
    stock changes, so webhook retries and concurrent refund/cancel flows are safe.
    Returns the number of orders actually restored.
    """
    pending = [order for order in orders if order.inventory_restored_at is None]
    if not pending:
        return 0

    menu_quantities: dict[int, int] = defaultdict(int)
    ingredient_quantities: dict[int, Decimal] = defaultdict(Decimal)
    for order in pending:
        for line in order.items:
            if line.menu_item_id and line.quantity > 0:
                menu_quantities[int(line.menu_item_id)] += int(line.quantity)
        for ingredient_id, quantity in _ingredient_usage(db, order).items():
            ingredient_quantities[int(ingredient_id)] += Decimal(quantity)

    if menu_quantities:
        menu_items = db.scalars(
            select(models.MenuItem)
            .where(models.MenuItem.id.in_(sorted(menu_quantities)))
            .order_by(models.MenuItem.id)
            .with_for_update()
        ).all()
        for item in menu_items:
            item.stock += menu_quantities.get(item.id, 0)

    if ingredient_quantities:
        ingredients = db.scalars(
            select(models.IngredientStock)
            .where(models.IngredientStock.id.in_(sorted(ingredient_quantities)))
            .order_by(models.IngredientStock.id)
            .with_for_update()
        ).all()
        for ingredient in ingredients:
            ingredient.quantity = Decimal(ingredient.quantity) + ingredient_quantities.get(ingredient.id, Decimal("0"))

    stamp = datetime.now(timezone.utc)
    for order in pending:
        order.inventory_restored_at = stamp
    return len(pending)


def restore_order_inventory(db: Session, order: models.Order) -> bool:
    return restore_orders_inventory(db, [order]) == 1
