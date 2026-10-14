"""inventory reservation snapshots and exactly-once restore marker

Revision ID: f14b00000001
Revises: f13b00000001
"""
from alembic import op
import sqlalchemy as sa

revision = "f14b00000001"
down_revision = "f13b00000001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("orders", sa.Column("inventory_reserved_json", sa.Text(), nullable=False, server_default="{}"))
    op.add_column("orders", sa.Column("inventory_restored_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    op.drop_column("orders", "inventory_restored_at")
    op.drop_column("orders", "inventory_reserved_json")
