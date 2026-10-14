"""Tala Eats v1.4 core resilience

Revision ID: f15c00000001
Revises: f14b00000001
"""
from alembic import op
import sqlalchemy as sa
import os

revision = "f15c00000001"
down_revision = "f14b00000001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "event_outbox",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_key", sa.String(220), nullable=False),
        sa.Column("aggregate_type", sa.String(60), nullable=False),
        sa.Column("aggregate_id", sa.String(120), nullable=False),
        sa.Column("event_type", sa.String(120), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("status", sa.String(30), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(1000), nullable=False, server_default=""),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("event_key", name="uq_event_outbox_event_key"),
    )
    op.create_index("ix_event_outbox_status_next", "event_outbox", ["status", "next_attempt_at", "created_at"])
    op.create_index("ix_event_outbox_aggregate", "event_outbox", ["aggregate_type", "aggregate_id", "created_at"])
    op.create_index("ix_event_outbox_event_type", "event_outbox", ["event_type", "created_at"])

    op.create_table(
        "dead_letter_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source", sa.String(60), nullable=False),
        sa.Column("source_id", sa.String(120), nullable=False, server_default=""),
        sa.Column("kind", sa.String(120), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("error", sa.Text(), nullable=False, server_default=""),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(30), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_dead_letter_jobs_open", "dead_letter_jobs", ["status", "created_at"])
    op.create_index("ix_dead_letter_jobs_kind", "dead_letter_jobs", ["kind", "created_at"])

    op.create_table(
        "payment_reconciliations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("provider", sa.String(40), nullable=False, server_default="mercadopago"),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=True),
        sa.Column("provider_payment_id", sa.String(160), nullable=False, server_default=""),
        sa.Column("local_status", sa.String(40), nullable=False, server_default=""),
        sa.Column("provider_status", sa.String(40), nullable=False, server_default=""),
        sa.Column("action", sa.String(80), nullable=False, server_default="none"),
        sa.Column("detail", sa.Text(), nullable=False, server_default=""),
        sa.Column("status", sa.String(30), nullable=False, server_default="checked"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_payment_reconciliation_order", "payment_reconciliations", ["order_id", "created_at"])
    op.create_index("ix_payment_reconciliation_status", "payment_reconciliations", ["status", "created_at"])

    op.create_table(
        "system_alerts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("alert_key", sa.String(160), nullable=False),
        sa.Column("severity", sa.String(20), nullable=False, server_default="warning"),
        sa.Column("component", sa.String(60), nullable=False, server_default="backend"),
        sa.Column("message", sa.String(500), nullable=False),
        sa.Column("detail_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("status", sa.String(30), nullable=False, server_default="open"),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_system_alerts_open", "system_alerts", ["status", "severity", "last_seen_at"])
    op.create_index("ix_system_alerts_key", "system_alerts", ["alert_key", "status"])

    with op.batch_alter_table("fraud_flags") as batch:
        batch.add_column(sa.Column("risk_score", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("signal", sa.String(80), nullable=False, server_default="rules"))
        batch.create_index("ix_fraud_flags_user_id", ["user_id"])
        batch.create_index("ix_fraud_flags_order_id", ["order_id"])
        batch.create_index("ix_fraud_flags_severity", ["severity"])
        batch.create_index("ix_fraud_flags_risk_score", ["risk_score"])
        batch.create_index("ix_fraud_flags_signal", ["signal"])
        batch.create_index("ix_fraud_flags_resolved", ["resolved"])
        batch.create_index("ix_fraud_flags_created_at", ["created_at"])

    with op.batch_alter_table("device_sessions") as batch:
        batch.add_column(sa.Column("device_id_hash", sa.String(64), nullable=False, server_default=""))
        batch.add_column(sa.Column("platform", sa.String(40), nullable=False, server_default="unknown"))
        batch.add_column(sa.Column("risk_score", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("trusted", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.create_index("ix_device_sessions_device_id_hash", ["device_id_hash"])
        batch.create_index("ix_device_sessions_platform", ["platform"])
        batch.create_index("ix_device_sessions_trusted", ["trusted"])

    with op.batch_alter_table("audit_events") as batch:
        batch.add_column(sa.Column("request_id", sa.String(128), nullable=False, server_default=""))
        batch.add_column(sa.Column("ip_address", sa.String(80), nullable=False, server_default=""))
        batch.add_column(sa.Column("device_session_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("before_json", sa.Text(), nullable=False, server_default="{}"))
        batch.add_column(sa.Column("after_json", sa.Text(), nullable=False, server_default="{}"))
        batch.create_foreign_key("fk_audit_events_device_session", "device_sessions", ["device_session_id"], ["id"])
        batch.create_index("ix_audit_events_request_id", ["request_id"])
        batch.create_index("ix_audit_events_device_session_id", ["device_session_id"])

    # Hot-path indexes for reconciliation and durable event draining.
    op.create_index("ix_orders_payment_reconcile", "orders", ["payment_method", "payment_status", "updated_at"])
    op.create_index("ix_orders_driver_dispatch_v14", "orders", ["status", "order_type", "driver_id", "ready_at"])

    # Existing production databases already contain feature_flags, but seed_database
    # is intentionally disabled there. Insert V1.4 switches during the migration so
    # every new engine has a kill-switch/rollout control immediately after deploy.
    bind = op.get_bind()
    flags = [
        ("core.durable_outbox", "Outbox transaccional durable V1.4", True, 100, "all"),
        ("payments.reconciliation", "Conciliación automática de pagos", True, 100, "admin"),
        ("dispatch.v2", "Dispatch ETA + fairness V2", True, 100, "driver"),
        ("security.fraud_v14", "Señales antifraude explicables", True, 100, "admin"),
        ("geo.postgis", "Aceleración geoespacial PostGIS", False, 0, "all"),
    ]
    for key, description, enabled, rollout, audience in flags:
        exists = bind.execute(sa.text("SELECT 1 FROM feature_flags WHERE key=:key"), {"key": key}).first()
        if not exists:
            bind.execute(sa.text("""
                INSERT INTO feature_flags
                    (key, description, enabled, rollout_percent, audience_role, created_at, updated_at)
                VALUES (:key, :description, :enabled, :rollout, :audience, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """), {"key": key, "description": description, "enabled": enabled, "rollout": rollout, "audience": audience})

    if bind.dialect.name == "postgresql" and os.getenv("POSTGIS_ENABLED", "false").strip().lower() in {"1","true","yes","on"}:
        op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        op.execute("CREATE INDEX IF NOT EXISTS ix_driver_profiles_geo_gist ON driver_profiles USING gist ((ST_SetSRID(ST_MakePoint(current_lng,current_lat),4326)::geography)) WHERE current_lat IS NOT NULL AND current_lng IS NOT NULL")
        op.execute("CREATE INDEX IF NOT EXISTS ix_restaurants_geo_gist ON restaurants USING gist ((ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography))")
    if bind.dialect.name == "postgresql":
        # BRIN indexes keep append-heavy history efficient with tiny index size and
        # prepare these tables for later time partitioning without forcing an unsafe
        # online table rewrite during this release.
        op.execute("CREATE INDEX IF NOT EXISTS ix_order_events_created_brin ON order_events USING brin (created_at)")
        op.execute("CREATE INDEX IF NOT EXISTS ix_product_events_created_brin ON product_events USING brin (created_at)")
        op.execute("CREATE INDEX IF NOT EXISTS ix_audit_events_created_brin ON audit_events USING brin (created_at)")
        op.execute("CREATE INDEX IF NOT EXISTS ix_financial_ledger_created_brin ON financial_ledger_entries USING brin (created_at)")
        # The financial ledger is append-only in production. Corrections are posted
        # as compensating entries, never destructive UPDATE/DELETE operations.
        op.execute("""
        CREATE OR REPLACE FUNCTION talaeats_prevent_ledger_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'financial_ledger_entries is append-only; post a compensating entry';
        END; $$;
        """)
        op.execute("""
        CREATE TRIGGER trg_financial_ledger_immutable
        BEFORE UPDATE OR DELETE ON financial_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION talaeats_prevent_ledger_mutation();
        """)
        # Security/admin audit is append-only for the same reason: history may
        # be compensated/explained, never silently rewritten after the fact.
        op.execute("""
        CREATE OR REPLACE FUNCTION talaeats_prevent_audit_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'audit_events is append-only';
        END; $$;
        """)
        op.execute("""
        CREATE TRIGGER trg_audit_events_immutable
        BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION talaeats_prevent_audit_mutation();
        """)


def downgrade():
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("DROP INDEX IF EXISTS ix_driver_profiles_geo_gist")
        op.execute("DROP INDEX IF EXISTS ix_restaurants_geo_gist")
        op.execute("DROP INDEX IF EXISTS ix_order_events_created_brin")
        op.execute("DROP INDEX IF EXISTS ix_product_events_created_brin")
        op.execute("DROP INDEX IF EXISTS ix_audit_events_created_brin")
        op.execute("DROP INDEX IF EXISTS ix_financial_ledger_created_brin")
        op.execute("DROP TRIGGER IF EXISTS trg_audit_events_immutable ON audit_events")
        op.execute("DROP FUNCTION IF EXISTS talaeats_prevent_audit_mutation()")
        op.execute("DROP TRIGGER IF EXISTS trg_financial_ledger_immutable ON financial_ledger_entries")
        op.execute("DROP FUNCTION IF EXISTS talaeats_prevent_ledger_mutation()")
    op.drop_index("ix_orders_driver_dispatch_v14", table_name="orders")
    op.drop_index("ix_orders_payment_reconcile", table_name="orders")
    with op.batch_alter_table("audit_events") as batch:
        batch.drop_index("ix_audit_events_device_session_id")
        batch.drop_index("ix_audit_events_request_id")
        batch.drop_constraint("fk_audit_events_device_session", type_="foreignkey")
        batch.drop_column("after_json")
        batch.drop_column("before_json")
        batch.drop_column("device_session_id")
        batch.drop_column("ip_address")
        batch.drop_column("request_id")
    with op.batch_alter_table("device_sessions") as batch:
        batch.drop_index("ix_device_sessions_trusted")
        batch.drop_index("ix_device_sessions_platform")
        batch.drop_index("ix_device_sessions_device_id_hash")
        batch.drop_column("trusted")
        batch.drop_column("risk_score")
        batch.drop_column("platform")
        batch.drop_column("device_id_hash")
    with op.batch_alter_table("fraud_flags") as batch:
        for name in ["ix_fraud_flags_created_at", "ix_fraud_flags_resolved", "ix_fraud_flags_signal", "ix_fraud_flags_risk_score", "ix_fraud_flags_severity", "ix_fraud_flags_order_id", "ix_fraud_flags_user_id"]:
            batch.drop_index(name)
        batch.drop_column("signal")
        batch.drop_column("risk_score")
    op.drop_table("system_alerts")
    op.drop_table("payment_reconciliations")
    op.drop_table("dead_letter_jobs")
    op.drop_table("event_outbox")
