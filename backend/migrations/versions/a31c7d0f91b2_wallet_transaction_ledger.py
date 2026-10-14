"""wallet transaction ledger

Revision ID: a31c7d0f91b2
Revises: e7f5933ec151
Create Date: 2026-08-21 23:10:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a31c7d0f91b2"
down_revision: Union[str, Sequence[str], None] = "e7f5933ec151"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "wallet_transactions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("amount", sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column("balance_after", sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column("reference_type", sa.String(length=40), nullable=False),
        sa.Column("reference_id", sa.String(length=120), nullable=False),
        sa.Column("description", sa.String(length=300), nullable=False),
        sa.Column("idempotency_key", sa.String(length=180), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key"),
    )
    op.create_index(op.f("ix_wallet_transactions_user_id"), "wallet_transactions", ["user_id"], unique=False)
    op.create_index(op.f("ix_wallet_transactions_kind"), "wallet_transactions", ["kind"], unique=False)
    op.create_index(op.f("ix_wallet_transactions_idempotency_key"), "wallet_transactions", ["idempotency_key"], unique=True)
    op.create_index(op.f("ix_wallet_transactions_created_at"), "wallet_transactions", ["created_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_wallet_transactions_created_at"), table_name="wallet_transactions")
    op.drop_index(op.f("ix_wallet_transactions_idempotency_key"), table_name="wallet_transactions")
    op.drop_index(op.f("ix_wallet_transactions_kind"), table_name="wallet_transactions")
    op.drop_index(op.f("ix_wallet_transactions_user_id"), table_name="wallet_transactions")
    op.drop_table("wallet_transactions")
