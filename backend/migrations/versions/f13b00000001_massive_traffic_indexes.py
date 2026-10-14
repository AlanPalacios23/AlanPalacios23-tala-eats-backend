"""massive traffic hot-path indexes

Revision ID: f13b00000001
Revises: e12a00000001
"""
from alembic import op
import sqlalchemy as sa

revision = "f13b00000001"
down_revision = "e12a00000001"
branch_labels = None
depends_on = None


def upgrade():
    # Order lifecycle / customer history.
    op.create_index("ix_orders_user_created", "orders", ["user_id", "created_at"], unique=False)
    op.create_index(
        "ix_orders_dispatch_ready",
        "orders",
        ["created_at"],
        unique=False,
        postgresql_where=sa.text("status = 'ready' AND driver_id IS NULL"),
    )
    op.create_index(
        "ix_orders_driver_active_updated",
        "orders",
        ["driver_id", "updated_at"],
        unique=False,
        postgresql_where=sa.text("driver_id IS NOT NULL AND status IN ('assigned','picked_up','on_the_way')"),
    )
    op.create_index(
        "ix_orders_payment_expiry_scan",
        "orders",
        ["created_at"],
        unique=False,
        postgresql_where=sa.text("payment_method = 'mercadopago' AND payment_status = 'pending' AND status = 'received'"),
    )

    # High-volume feeds and histories.
    op.create_index(
        "ix_notifications_user_unread_created",
        "notifications",
        ["user_id", "created_at"],
        unique=False,
        postgresql_where=sa.text("is_read = false"),
    )
    op.create_index("ix_order_events_order_created", "order_events", ["order_id", "created_at"], unique=False)
    op.create_index("ix_chat_messages_order_created", "chat_messages", ["order_id", "created_at"], unique=False)

    # Worker queues / expiring work.
    op.create_index(
        "ix_email_outbox_pending_created",
        "email_outbox",
        ["created_at"],
        unique=False,
        postgresql_where=sa.text("status IN ('pending','retry') AND attempts < 5"),
    )
    op.create_index(
        "ix_driver_offers_offered_expiry",
        "driver_offers",
        ["expires_at"],
        unique=False,
        postgresql_where=sa.text("status = 'offered'"),
    )
    op.create_index(
        "ix_substitution_pending_expiry",
        "substitution_requests",
        ["expires_at"],
        unique=False,
        postgresql_where=sa.text("status = 'pending'"),
    )

    # Authentication and driver dispatch hot paths.
    op.create_index(
        "ix_device_sessions_hash_active",
        "device_sessions",
        ["session_hash"],
        unique=False,
        postgresql_where=sa.text("active = true"),
    )
    op.create_index(
        "ix_driver_profiles_dispatch",
        "driver_profiles",
        ["updated_at"],
        unique=False,
        postgresql_where=sa.text("is_online = true AND is_verified = true"),
    )


def downgrade():
    op.drop_index("ix_driver_profiles_dispatch", table_name="driver_profiles")
    op.drop_index("ix_device_sessions_hash_active", table_name="device_sessions")
    op.drop_index("ix_substitution_pending_expiry", table_name="substitution_requests")
    op.drop_index("ix_driver_offers_offered_expiry", table_name="driver_offers")
    op.drop_index("ix_email_outbox_pending_created", table_name="email_outbox")
    op.drop_index("ix_chat_messages_order_created", table_name="chat_messages")
    op.drop_index("ix_order_events_order_created", table_name="order_events")
    op.drop_index("ix_notifications_user_unread_created", table_name="notifications")
    op.drop_index("ix_orders_payment_expiry_scan", table_name="orders")
    op.drop_index("ix_orders_driver_active_updated", table_name="orders")
    op.drop_index("ix_orders_dispatch_ready", table_name="orders")
    op.drop_index("ix_orders_user_created", table_name="orders")
