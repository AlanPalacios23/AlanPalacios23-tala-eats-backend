"""Isolated Finance Core V2 shadow tables; no real money movement.

Revision ID: f22j00000001
Revises: f21i00000001

No historical order is backfilled; no Stripe/wallet legacy table is changed.
"""
from alembic import op
import sqlalchemy as sa

revision = "f22j00000001"
down_revision = "f21i00000001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "finance_v2_wallets",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("owner_type", sa.String(20), nullable=False),
        sa.Column("owner_id", sa.Integer, nullable=False),
        sa.Column("balance_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("unfunded_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("cash_exposure_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("currency", sa.String(3), nullable=False, server_default="MXN"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("owner_type", "owner_id", name="uq_fin_v2_wallet_owner"),
        sa.CheckConstraint("unfunded_cents >= 0 AND cash_exposure_cents >= 0", name="ck_fin_v2_wallet_holds_positive"),
        sa.CheckConstraint("owner_type IN ('driver','restaurant') AND currency = 'MXN'", name="ck_fin_v2_wallet_mxn"),
    )
    op.create_table(
        "finance_v2_journals",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("order_id", sa.Integer, sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("event_type", sa.String(35), nullable=False),
        sa.Column("payment_method", sa.String(30), nullable=False),
        sa.Column("total_cents", sa.BigInteger, nullable=False),
        sa.Column("platform_revenue_cents", sa.BigInteger, nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="MXN"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("order_id", "event_type", name="uq_fin_v2_order_event"),
        sa.CheckConstraint("total_cents >= 0 AND currency = 'MXN'", name="ck_fin_v2_journal_mxn"),
    )
    op.create_index("ix_fin_v2_journals_order_id", "finance_v2_journals", ["order_id"])
    op.create_table(
        "finance_v2_journal_lines",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("journal_id", sa.Integer, sa.ForeignKey("finance_v2_journals.id"), nullable=False),
        sa.Column("seq", sa.Integer, nullable=False),
        sa.Column("account", sa.String(90), nullable=False),
        sa.Column("direction", sa.String(6), nullable=False),
        sa.Column("amount_cents", sa.BigInteger, nullable=False),
        sa.Column("owner_type", sa.String(20), nullable=True),
        sa.Column("owner_id", sa.Integer, nullable=True),
        sa.UniqueConstraint("journal_id", "seq", name="uq_fin_v2_journal_seq"),
        sa.CheckConstraint("amount_cents > 0 AND direction IN ('debit','credit')", name="ck_fin_v2_entry_positive"),
    )
    op.create_index("ix_fin_v2_lines_journal_id", "finance_v2_journal_lines", ["journal_id"])
    op.create_index("ix_fin_v2_lines_account", "finance_v2_journal_lines", ["account"])
    op.create_table(
        "finance_v2_wallet_movements",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("journal_id", sa.Integer, sa.ForeignKey("finance_v2_journals.id"), nullable=False),
        sa.Column("owner_type", sa.String(20), nullable=False),
        sa.Column("owner_id", sa.Integer, nullable=False),
        sa.Column("amount_cents", sa.BigInteger, nullable=False),
        sa.Column("unfunded_delta_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("cash_exposure_delta_cents", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("journal_id", "owner_type", "owner_id", name="uq_fin_v2_mov_wallet"),
    )
    op.create_index("ix_fin_v2_mov_journal_id", "finance_v2_wallet_movements", ["journal_id"])
    op.create_table(
        "finance_v2_cash_allocations",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("order_id", sa.Integer, sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("journal_id", sa.Integer, sa.ForeignKey("finance_v2_journals.id"), nullable=False),
        sa.Column("collector_type", sa.String(20), nullable=False),
        sa.Column("collector_id", sa.Integer, nullable=False),
        sa.Column("received_cash_cents", sa.BigInteger, nullable=False),
        sa.Column("owed_by_collector_cents", sa.BigInteger, nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="recorded"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("order_id", name="uq_fin_v2_cash_order"),
        sa.CheckConstraint("received_cash_cents >= 0 AND owed_by_collector_cents >= 0", name="ck_fin_v2_cash_positive"),
        sa.CheckConstraint("collector_type IN ('driver','restaurant')", name="ck_fin_v2_cash_owner"),
    )
    op.create_index("ix_fin_v2_alloc_order_id", "finance_v2_cash_allocations", ["order_id"])
    # Write-once financial evidence in PostgreSQL. Wallet summary rows are
    # mutable projections; the source-of-truth journal/movements are not.
    if op.get_bind().dialect.name == "postgresql":
        op.execute("""
        CREATE FUNCTION fin_v2_protect_immutable() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'Finance V2 evidence is append-only';
        END;
        $$ LANGUAGE plpgsql
        """)
        for table in ("finance_v2_journals", "finance_v2_journal_lines",
                      "finance_v2_wallet_movements", "finance_v2_cash_allocations"):
            op.execute(f"CREATE TRIGGER fin_v2_immutable BEFORE UPDATE OR DELETE ON {table} "
                       "FOR EACH ROW EXECUTE FUNCTION fin_v2_protect_immutable()")


def downgrade():
    raise RuntimeError("Finance V2: no borrar evidencia financiera sin backup y aprobación")
