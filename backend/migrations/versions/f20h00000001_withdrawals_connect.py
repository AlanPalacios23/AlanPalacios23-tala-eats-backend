"""On-demand withdrawals audit rows (not backfilled or enabled by migration).

Revision ID: f20h00000001
Revises: f19g00000001
"""
from alembic import op
import sqlalchemy as sa

revision = "f20h00000001"
down_revision = "f19g00000001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "withdrawal_requests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("payee_type", sa.String(length=30), nullable=False),
        sa.Column("payee_id", sa.Integer(), nullable=False),
        sa.Column("requested_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("connected_account_id", sa.String(length=120), nullable=False),
        sa.Column("bank_destination_id", sa.String(length=180), nullable=True),
        sa.Column("client_key", sa.String(length=100), nullable=False),
        sa.Column("amount_cents", sa.Integer(), nullable=False),
        sa.Column("otp_step", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=8), nullable=False, server_default="MXN"),
        sa.Column("status", sa.String(length=40), nullable=False, server_default="reserved"),
        sa.Column("stripe_payout_id", sa.String(length=180), nullable=True),
        sa.Column("error_code", sa.String(length=80), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("payee_type", "payee_id", "client_key", name="uq_withdrawal_payee_key"),
        sa.UniqueConstraint("requested_by", "otp_step", name="uq_withdrawal_one_use_per_totp"),
        sa.UniqueConstraint("stripe_payout_id", name="uq_withdrawal_stripe_payout_id"),
    )
    op.create_index("ix_withdrawal_requests_payee_type", "withdrawal_requests", ["payee_type"])
    op.create_index("ix_withdrawal_requests_payee_id", "withdrawal_requests", ["payee_id"])
    op.create_index("ix_withdrawal_requests_status", "withdrawal_requests", ["status"])


def downgrade():
    # Do not drop banking/payment audit data automatically.
    raise RuntimeError("El historial de retiros requiere migración inversa auditada manualmente")
