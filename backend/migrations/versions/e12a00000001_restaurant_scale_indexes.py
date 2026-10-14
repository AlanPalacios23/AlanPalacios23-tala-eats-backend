"""restaurant scale indexes

Revision ID: e12a00000001
Revises: d11f00000001
"""
from alembic import op

revision = "e12a00000001"
down_revision = "d11f00000001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index(
        "ix_orders_restaurant_status_created",
        "orders",
        ["restaurant_id", "status", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_orders_restaurant_created",
        "orders",
        ["restaurant_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_menu_items_restaurant_available_stock",
        "menu_items",
        ["restaurant_id", "is_available", "stock"],
        unique=False,
    )


def downgrade():
    op.drop_index("ix_menu_items_restaurant_available_stock", table_name="menu_items")
    op.drop_index("ix_orders_restaurant_created", table_name="orders")
    op.drop_index("ix_orders_restaurant_status_created", table_name="orders")
