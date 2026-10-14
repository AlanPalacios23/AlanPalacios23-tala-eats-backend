"""Tala Eats V11 launch-ready scale and real-integration primitives

Revision ID: d11f00000001
Revises: c9f000000001
"""
from alembic import op
import sqlalchemy as sa

revision = "d11f00000001"
down_revision = "c9f000000001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("analytics_opt_in", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("users", sa.Column("personalization_opt_in", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("orders", sa.Column("refunded_amount", sa.Numeric(10,2), nullable=False, server_default="0"))
    op.add_column("payouts", sa.Column("provider", sa.String(40), nullable=False, server_default="manual"))
    op.add_column("payouts", sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("payouts", sa.Column("failure_reason", sa.String(500), nullable=False, server_default=""))

    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("endpoint", sa.String(1200), nullable=False),
        sa.Column("p256dh", sa.String(300), nullable=False, server_default=""),
        sa.Column("auth", sa.String(300), nullable=False, server_default=""),
        sa.Column("platform", sa.String(40), nullable=False, server_default="web"),
        sa.Column("device_label", sa.String(200), nullable=False, server_default=""),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "endpoint", name="uq_push_user_endpoint"),
    )
    op.create_index("ix_push_subscriptions_user_id","push_subscriptions",["user_id"])
    op.create_index("ix_push_subscriptions_active","push_subscriptions",["active"])

    op.create_table(
        "refund_adjustments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("amount", sa.Numeric(10,2), nullable=False, server_default="0"),
        sa.Column("reason", sa.String(300), nullable=False, server_default=""),
        sa.Column("provider", sa.String(40), nullable=False, server_default=""),
        sa.Column("provider_ref", sa.String(220), nullable=False, server_default=""),
        sa.Column("status", sa.String(30), nullable=False, server_default="pending"),
        sa.Column("idempotency_key", sa.String(180), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("idempotency_key", name="uq_refund_adjustment_idem"),
    )
    for c in ["order_id","created_by_user_id","status","idempotency_key"]:
        op.create_index(f"ix_refund_adjustments_{c}","refund_adjustments",[c])

    op.create_table(
        "substitution_requests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("order_item_id", sa.Integer(), sa.ForeignKey("order_items.id"), nullable=False),
        sa.Column("restaurant_id", sa.Integer(), sa.ForeignKey("restaurants.id"), nullable=False),
        sa.Column("requested_by_user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("replacement_menu_item_id", sa.Integer(), sa.ForeignKey("menu_items.id"), nullable=True),
        sa.Column("issue_type", sa.String(40), nullable=False, server_default="unavailable"),
        sa.Column("message", sa.String(500), nullable=False, server_default=""),
        sa.Column("original_amount", sa.Numeric(10,2), nullable=False, server_default="0"),
        sa.Column("replacement_amount", sa.Numeric(10,2), nullable=False, server_default="0"),
        sa.Column("status", sa.String(30), nullable=False, server_default="pending"),
        sa.Column("resolution", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    for c in ["order_id","order_item_id","restaurant_id","requested_by_user_id","status"]:
        op.create_index(f"ix_substitution_requests_{c}","substitution_requests",[c])

    op.create_table(
        "driver_offers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("driver_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("round_no", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.String(30), nullable=False, server_default="offered"),
        sa.Column("score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("estimated_pickup_min", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("estimated_earning", sa.Numeric(10,2), nullable=False, server_default="0"),
        sa.Column("offered_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("order_id","driver_id","round_no",name="uq_driver_offer_round"),
    )
    for c in ["order_id","driver_id","status","expires_at"]:
        op.create_index(f"ix_driver_offers_{c}","driver_offers",[c])

    op.create_table(
        "integration_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("provider", sa.String(60), nullable=False),
        sa.Column("external_id", sa.String(220), nullable=False),
        sa.Column("event_type", sa.String(100), nullable=False, server_default="event"),
        sa.Column("status", sa.String(30), nullable=False, server_default="received"),
        sa.Column("payload", sa.Text(), nullable=False, server_default=""),
        sa.Column("last_error", sa.String(500), nullable=False, server_default=""),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("provider","external_id",name="uq_integration_event_provider_external"),
    )
    for c in ["provider","external_id","status"]:
        op.create_index(f"ix_integration_events_{c}","integration_events",[c])


def downgrade():
    for table in ["integration_events","driver_offers","substitution_requests","refund_adjustments","push_subscriptions"]:
        op.drop_table(table)
    for c in ["provider","attempts","failure_reason"]:
        op.drop_column("payouts",c)
    op.drop_column("orders","refunded_amount")
    op.drop_column("users","personalization_opt_in")
    op.drop_column("users","analytics_opt_in")
