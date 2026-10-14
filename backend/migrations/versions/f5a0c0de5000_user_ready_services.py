"""user-ready services

Revision ID: f5a0c0de5000
Revises: a31c7d0f91b2
Create Date: 2026-09-12 13:30:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "f5a0c0de5000"
down_revision: Union[str, Sequence[str], None] = "a31c7d0f91b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("orders", sa.Column("client_reference", sa.String(length=80), nullable=True))
    op.create_index(op.f("ix_orders_client_reference"), "orders", ["client_reference"], unique=False)
    op.create_unique_constraint("uq_order_user_client_reference", "orders", ["user_id", "client_reference"])

    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_password_reset_tokens_user_id", "password_reset_tokens", ["user_id"])
    op.create_index("ix_password_reset_tokens_token_hash", "password_reset_tokens", ["token_hash"], unique=True)
    op.create_index("ix_password_reset_tokens_expires_at", "password_reset_tokens", ["expires_at"])

    op.create_table(
        "email_outbox",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("to_email", sa.String(length=255), nullable=False),
        sa.Column("subject", sa.String(length=220), nullable=False),
        sa.Column("text_body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=30), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("last_error", sa.String(length=500), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_email_outbox_to_email", "email_outbox", ["to_email"])
    op.create_index("ix_email_outbox_status", "email_outbox", ["status"])
    op.create_index("ix_email_outbox_created_at", "email_outbox", ["created_at"])

    op.create_table(
        "audit_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("action", sa.String(length=100), nullable=False),
        sa.Column("entity_type", sa.String(length=80), nullable=False),
        sa.Column("entity_id", sa.String(length=120), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_audit_events_user_id", "audit_events", ["user_id"])
    op.create_index("ix_audit_events_action", "audit_events", ["action"])
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"])


def downgrade() -> None:
    op.drop_table("audit_events")
    op.drop_table("email_outbox")
    op.drop_table("password_reset_tokens")
    op.drop_constraint("uq_order_user_client_reference", "orders", type_="unique")
    op.drop_index(op.f("ix_orders_client_reference"), table_name="orders")
    op.drop_column("orders", "client_reference")
