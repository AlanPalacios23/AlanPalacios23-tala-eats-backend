"""Stripe marketplace settlement records and driver recipient reference.

Revision ID: f16d00000001
Revises: f15c00000001
"""
from alembic import op
import sqlalchemy as sa

revision = "f16d00000001"
down_revision = "f15c00000001"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("driver_profiles") as batch:
        batch.add_column(sa.Column("payout_account_ref", sa.String(180), nullable=False, server_default=""))
    op.create_table(
        "stripe_transfers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("recipient_type", sa.String(30), nullable=False),
        sa.Column("connected_account_id", sa.String(120), nullable=False),
        sa.Column("amount_cents", sa.Integer(), nullable=False),
        sa.Column("transfer_id", sa.String(150), nullable=False, server_default=""),
        sa.Column("status", sa.String(30), nullable=False, server_default="pending"),
        sa.Column("last_error", sa.String(1000), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("order_id", "recipient_type", name="uq_stripe_transfer_order_recipient"),
    )
    op.create_index("ix_stripe_transfers_order_id", "stripe_transfers", ["order_id"])


def downgrade():
    op.drop_index("ix_stripe_transfers_order_id", table_name="stripe_transfers")
    op.drop_table("stripe_transfers")
    with op.batch_alter_table("driver_profiles") as batch:
        batch.drop_column("payout_account_ref")
