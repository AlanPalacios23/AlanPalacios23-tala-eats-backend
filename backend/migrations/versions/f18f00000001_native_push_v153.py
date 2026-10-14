"""FCM device registry and durable per-notification delivery queue.

Revision ID: f18f00000001
Revises: f17e00000001
"""
from alembic import op
import sqlalchemy as sa

revision = "f18f00000001"
down_revision = "f17e00000001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("mobile_push_devices",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("application", sa.String(length=20), nullable=False),
        sa.Column("platform", sa.String(length=10), nullable=False),
        sa.Column("device_id", sa.String(length=96), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("encrypted_token", sa.Text(), nullable=False),
        sa.Column("marketing_push_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("token_hash", name="uq_mobile_push_token_hash"),
        sa.UniqueConstraint("user_id", "application", "device_id", name="uq_mobile_push_user_app_device"),
    )
    op.create_index("ix_mobile_push_devices_user_id", "mobile_push_devices", ["user_id"])
    op.create_index("ix_mobile_push_devices_active", "mobile_push_devices", ["active"])
    op.create_table("mobile_push_deliveries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("notification_id", sa.Integer(), sa.ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("mobile_push_devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("claimed_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(length=240), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("notification_id", "device_id", name="uq_mobile_push_notification_device"),
    )
    op.create_index("ix_mobile_push_deliveries_notification_id", "mobile_push_deliveries", ["notification_id"])
    op.create_index("ix_mobile_push_deliveries_device_id", "mobile_push_deliveries", ["device_id"])
    op.create_index("ix_mobile_push_deliveries_state", "mobile_push_deliveries", ["state"])


def downgrade():
    op.drop_index("ix_mobile_push_deliveries_state", table_name="mobile_push_deliveries")
    op.drop_index("ix_mobile_push_deliveries_device_id", table_name="mobile_push_deliveries")
    op.drop_index("ix_mobile_push_deliveries_notification_id", table_name="mobile_push_deliveries")
    op.drop_table("mobile_push_deliveries")
    op.drop_index("ix_mobile_push_devices_active", table_name="mobile_push_devices")
    op.drop_index("ix_mobile_push_devices_user_id", table_name="mobile_push_devices")
    op.drop_table("mobile_push_devices")
