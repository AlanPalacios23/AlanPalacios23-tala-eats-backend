"""Tala Eats V6 commerce, operations and finance

Revision ID: b6f000000001
Revises: f5a0c0de5000
"""
from alembic import op
import sqlalchemy as sa

revision = "b6f000000001"
down_revision = "f5a0c0de5000"
branch_labels = None
depends_on = None


def upgrade():
    for name, typ, default in [
        ("commercial_plan", sa.String(30), "START"),
        ("commission_rate", sa.Numeric(6,4), "0.1200"),
        ("service_fee_rate", sa.Numeric(6,4), "0.0400"),
        ("service_fee_fixed", sa.Numeric(10,2), "0.00"),
        ("branch_code", sa.String(40), "MAIN"),
        ("brand_name", sa.String(150), ""),
        ("onboarding_status", sa.String(30), "approved"),
        ("payout_account_ref", sa.String(180), ""),
    ]:
        op.add_column("restaurants", sa.Column(name, typ, nullable=False, server_default=default))
    op.create_index("ix_restaurants_commercial_plan", "restaurants", ["commercial_plan"])
    op.create_index("ix_restaurants_branch_code", "restaurants", ["branch_code"])
    op.create_index("ix_restaurants_onboarding_status", "restaurants", ["onboarding_status"])

    for name in ["service_fee","payment_processing_fee","promotion_subsidy","platform_revenue","contribution_margin","cash_collected","cancellation_fee"]:
        op.add_column("orders", sa.Column(name, sa.Numeric(10,2), nullable=False, server_default="0.00"))
    for name in ["accepted_at","preparing_at","ready_at","picked_up_at","delivered_at"]:
        op.add_column("orders", sa.Column(name, sa.DateTime(timezone=True), nullable=True))

    op.create_table("onboarding_applications",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),
        sa.Column("entity_type",sa.String(30),nullable=False),sa.Column("business_name",sa.String(160),nullable=False,server_default=""),
        sa.Column("tax_id",sa.String(60),nullable=False,server_default=""),sa.Column("vehicle",sa.String(100),nullable=False,server_default=""),
        sa.Column("documents_json",sa.Text(),nullable=False,server_default="[]"),sa.Column("payout_account_ref",sa.String(180),nullable=False,server_default=""),
        sa.Column("status",sa.String(30),nullable=False,server_default="pending"),sa.Column("notes",sa.Text(),nullable=False,server_default=""),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.Column("updated_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_onboarding_applications_user_id","onboarding_applications",["user_id"])
    op.create_index("ix_onboarding_applications_entity_type","onboarding_applications",["entity_type"])
    op.create_index("ix_onboarding_applications_status","onboarding_applications",["status"])

    op.create_table("service_zones",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("name",sa.String(120),nullable=False,unique=True),
        sa.Column("center_lat",sa.Float(),nullable=False),sa.Column("center_lng",sa.Float(),nullable=False),sa.Column("radius_km",sa.Float(),nullable=False,server_default="8"),
        sa.Column("surcharge",sa.Numeric(10,2),nullable=False,server_default="0"),sa.Column("min_order",sa.Numeric(10,2),nullable=False,server_default="0"),
        sa.Column("active",sa.Boolean(),nullable=False,server_default=sa.true()),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_service_zones_active","service_zones",["active"])

    op.create_table("financial_ledger_entries",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("order_id",sa.Integer(),sa.ForeignKey("orders.id")),sa.Column("user_id",sa.Integer(),sa.ForeignKey("users.id")),
        sa.Column("restaurant_id",sa.Integer(),sa.ForeignKey("restaurants.id")),sa.Column("account",sa.String(60),nullable=False),sa.Column("direction",sa.String(10),nullable=False,server_default="credit"),
        sa.Column("amount",sa.Numeric(12,2),nullable=False,server_default="0"),sa.Column("currency",sa.String(8),nullable=False,server_default="MXN"),sa.Column("kind",sa.String(60),nullable=False),
        sa.Column("description",sa.String(300),nullable=False,server_default=""),sa.Column("idempotency_key",sa.String(180),nullable=False,unique=True),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False))
    for col in ["order_id","user_id","restaurant_id","account","kind","idempotency_key","created_at"]:
        op.create_index(f"ix_financial_ledger_entries_{col}","financial_ledger_entries",[col])

    op.create_table("payouts",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("payee_type",sa.String(30),nullable=False),sa.Column("payee_id",sa.Integer(),nullable=False),sa.Column("amount",sa.Numeric(12,2),nullable=False),
        sa.Column("currency",sa.String(8),nullable=False,server_default="MXN"),sa.Column("period_start",sa.DateTime(timezone=True),nullable=False),sa.Column("period_end",sa.DateTime(timezone=True),nullable=False),
        sa.Column("status",sa.String(30),nullable=False,server_default="pending"),sa.Column("provider_ref",sa.String(180),nullable=False,server_default=""),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.Column("paid_at",sa.DateTime(timezone=True)))
    for col in ["payee_type","payee_id","status","created_at"]:op.create_index(f"ix_payouts_{col}","payouts",[col])

    op.create_table("cash_settlements",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("driver_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),sa.Column("period_label",sa.String(60),nullable=False,server_default=""),
        sa.Column("cash_collected",sa.Numeric(12,2),nullable=False,server_default="0"),sa.Column("driver_earnings",sa.Numeric(12,2),nullable=False,server_default="0"),sa.Column("amount_due_platform",sa.Numeric(12,2),nullable=False,server_default="0"),
        sa.Column("status",sa.String(30),nullable=False,server_default="open"),sa.Column("notes",sa.String(400),nullable=False,server_default=""),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.Column("settled_at",sa.DateTime(timezone=True)))
    op.create_index("ix_cash_settlements_driver_id","cash_settlements",["driver_id"]);op.create_index("ix_cash_settlements_status","cash_settlements",["status"])

    op.create_table("disputes",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("order_id",sa.Integer(),sa.ForeignKey("orders.id"),nullable=False),sa.Column("opened_by_user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),
        sa.Column("category",sa.String(80),nullable=False),sa.Column("description",sa.Text(),nullable=False),sa.Column("status",sa.String(30),nullable=False,server_default="open"),
        sa.Column("resolution",sa.Text(),nullable=False,server_default=""),sa.Column("refund_amount",sa.Numeric(10,2),nullable=False,server_default="0"),sa.Column("assigned_to_user_id",sa.Integer(),sa.ForeignKey("users.id")),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.Column("resolved_at",sa.DateTime(timezone=True)))
    for col in ["order_id","opened_by_user_id","category","status","created_at"]:op.create_index(f"ix_disputes_{col}","disputes",[col])

    op.create_table("plus_subscriptions",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),sa.Column("plan",sa.String(30),nullable=False,server_default="PLUS"),
        sa.Column("price_monthly",sa.Numeric(10,2),nullable=False,server_default="79"),sa.Column("status",sa.String(30),nullable=False,server_default="active"),sa.Column("started_at",sa.DateTime(timezone=True),nullable=False),
        sa.Column("renews_at",sa.DateTime(timezone=True)),sa.Column("cancelled_at",sa.DateTime(timezone=True)))
    op.create_index("ix_plus_subscriptions_user_id","plus_subscriptions",["user_id"]);op.create_index("ix_plus_subscriptions_status","plus_subscriptions",["status"])

    op.create_table("sponsored_campaigns",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("restaurant_id",sa.Integer(),sa.ForeignKey("restaurants.id"),nullable=False),sa.Column("name",sa.String(150),nullable=False),
        sa.Column("daily_budget",sa.Numeric(10,2),nullable=False,server_default="100"),sa.Column("spent",sa.Numeric(10,2),nullable=False,server_default="0"),sa.Column("impressions",sa.Integer(),nullable=False,server_default="0"),
        sa.Column("clicks",sa.Integer(),nullable=False,server_default="0"),sa.Column("attributed_orders",sa.Integer(),nullable=False,server_default="0"),sa.Column("active",sa.Boolean(),nullable=False,server_default=sa.true()),
        sa.Column("starts_at",sa.DateTime(timezone=True),nullable=False),sa.Column("ends_at",sa.DateTime(timezone=True)))
    op.create_index("ix_sponsored_campaigns_restaurant_id","sponsored_campaigns",["restaurant_id"]);op.create_index("ix_sponsored_campaigns_active","sponsored_campaigns",["active"])

    op.create_table("referral_conversions",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("referrer_user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),sa.Column("referred_user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False,unique=True),
        sa.Column("referral_code",sa.String(30),nullable=False),sa.Column("qualifying_order_id",sa.Integer(),sa.ForeignKey("orders.id")),sa.Column("status",sa.String(30),nullable=False,server_default="pending"),
        sa.Column("reward_amount",sa.Numeric(10,2),nullable=False,server_default="50"),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.Column("rewarded_at",sa.DateTime(timezone=True)))
    for col in ["referrer_user_id","referred_user_id","referral_code","status"]:op.create_index(f"ix_referral_conversions_{col}","referral_conversions",[col])

    op.create_table("feature_flags",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("key",sa.String(100),nullable=False,unique=True),sa.Column("description",sa.String(300),nullable=False,server_default=""),
        sa.Column("enabled",sa.Boolean(),nullable=False,server_default=sa.false()),sa.Column("rollout_percent",sa.Integer(),nullable=False,server_default="100"),sa.Column("audience_role",sa.String(30),nullable=False,server_default="all"),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.Column("updated_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_feature_flags_key","feature_flags",["key"]);op.create_index("ix_feature_flags_enabled","feature_flags",["enabled"])

    op.create_table("system_settings",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("key",sa.String(100),nullable=False,unique=True),sa.Column("value",sa.String(500),nullable=False,server_default=""),
        sa.Column("value_type",sa.String(30),nullable=False,server_default="string"),sa.Column("description",sa.String(300),nullable=False,server_default=""),sa.Column("updated_by_user_id",sa.Integer(),sa.ForeignKey("users.id")),
        sa.Column("updated_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_system_settings_key","system_settings",["key"])

    op.create_table("order_events",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("order_id",sa.Integer(),sa.ForeignKey("orders.id"),nullable=False),sa.Column("status",sa.String(40),nullable=False),
        sa.Column("actor_user_id",sa.Integer(),sa.ForeignKey("users.id")),sa.Column("metadata_json",sa.Text(),nullable=False,server_default="{}"),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_order_events_order_id","order_events",["order_id"]);op.create_index("ix_order_events_status","order_events",["status"]);op.create_index("ix_order_events_created_at","order_events",["created_at"])

    op.create_table("simulation_runs",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("created_by_user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),sa.Column("scenario",sa.String(80),nullable=False,server_default="happy_path"),
        sa.Column("status",sa.String(30),nullable=False,server_default="created"),sa.Column("current_step",sa.String(60),nullable=False,server_default="customer_order"),sa.Column("state_json",sa.Text(),nullable=False,server_default="{}"),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.Column("updated_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_simulation_runs_created_by_user_id","simulation_runs",["created_by_user_id"]);op.create_index("ix_simulation_runs_status","simulation_runs",["status"])


def downgrade():
    for table in ["simulation_runs","order_events","system_settings","feature_flags","referral_conversions","sponsored_campaigns","plus_subscriptions","disputes","cash_settlements","payouts","financial_ledger_entries","service_zones","onboarding_applications"]:
        op.drop_table(table)
    for name in ["accepted_at","preparing_at","ready_at","picked_up_at","delivered_at","service_fee","payment_processing_fee","promotion_subsidy","platform_revenue","contribution_margin","cash_collected","cancellation_fee"]:
        op.drop_column("orders",name)
    for name in ["commercial_plan","commission_rate","service_fee_rate","service_fee_fixed","branch_code","brand_name","onboarding_status","payout_account_ref"]:
        op.drop_column("restaurants",name)
