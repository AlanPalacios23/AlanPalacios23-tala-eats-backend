"""Tala Eats V9 intelligence, growth and automation

Revision ID: c9f000000001
Revises: b6f000000001
"""
from alembic import op
import sqlalchemy as sa

revision = "c9f000000001"
down_revision = "b6f000000001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("two_factor_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("users", sa.Column("totp_secret", sa.String(80), nullable=False, server_default=""))
    op.add_column("users", sa.Column("marketing_opt_in", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("users", sa.Column("birth_date", sa.String(10), nullable=False, server_default=""))
    op.add_column("restaurants", sa.Column("market_code", sa.String(40), nullable=False, server_default="TALA-JAL"))
    op.create_index("ix_restaurants_market_code","restaurants",["market_code"])
    op.add_column("menu_items", sa.Column("availability_schedule_json", sa.Text(), nullable=False, server_default="{}"))
    op.add_column("menu_items", sa.Column("price_schedule_json", sa.Text(), nullable=False, server_default="{}"))
    for name, typ, default in [
        ("recipient_name", sa.String(120), ""), ("recipient_phone", sa.String(40), ""), ("gift_message", sa.String(300), "")
    ]: op.add_column("orders", sa.Column(name, typ, nullable=False, server_default=default))
    op.add_column("loyalty_accounts", sa.Column("tier", sa.String(20), nullable=False, server_default="BRONZE"))
    op.add_column("loyalty_accounts", sa.Column("streak_days", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("loyalty_accounts", sa.Column("plus_savings", sa.Numeric(10,2), nullable=False, server_default="0"))
    op.add_column("chat_messages", sa.Column("message_type", sa.String(30), nullable=False, server_default="text"))
    op.add_column("chat_messages", sa.Column("media_url", sa.String(600), nullable=False, server_default=""))
    op.add_column("chat_messages", sa.Column("lat", sa.Float(), nullable=True))
    op.add_column("chat_messages", sa.Column("lng", sa.Float(), nullable=True))

    op.create_table("product_events",
        sa.Column("id",sa.Integer(),primary_key=True),sa.Column("user_id",sa.Integer(),sa.ForeignKey("users.id")),sa.Column("session_id",sa.String(80),nullable=False,server_default=""),
        sa.Column("event_name",sa.String(100),nullable=False),sa.Column("route",sa.String(240),nullable=False,server_default=""),sa.Column("properties_json",sa.Text(),nullable=False,server_default="{}"),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False))
    for c in ["user_id","session_id","event_name","created_at"]: op.create_index(f"ix_product_events_{c}","product_events",[c])

    op.create_table("experiments",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("key",sa.String(100),nullable=False,unique=True),sa.Column("name",sa.String(180),nullable=False),sa.Column("variants_json",sa.Text(),nullable=False,server_default='["control","variant"]'),sa.Column("audience_role",sa.String(30),nullable=False,server_default="customer"),sa.Column("rollout_percent",sa.Integer(),nullable=False,server_default="100"),sa.Column("status",sa.String(30),nullable=False,server_default="draft"),sa.Column("primary_metric",sa.String(100),nullable=False,server_default="checkout_completed"),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_experiments_key","experiments",["key"]);op.create_index("ix_experiments_status","experiments",["status"])
    op.create_table("experiment_assignments",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("experiment_id",sa.Integer(),sa.ForeignKey("experiments.id"),nullable=False),sa.Column("user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),sa.Column("variant",sa.String(60),nullable=False),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.UniqueConstraint("experiment_id","user_id",name="uq_experiment_user"))
    op.create_index("ix_experiment_assignments_experiment_id","experiment_assignments",["experiment_id"]);op.create_index("ix_experiment_assignments_user_id","experiment_assignments",["user_id"])

    op.create_table("driver_incentives",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("zone_name",sa.String(120),nullable=False,server_default="General"),sa.Column("title",sa.String(180),nullable=False),sa.Column("bonus_per_delivery",sa.Numeric(10,2),nullable=False,server_default="0"),sa.Column("multiplier",sa.Numeric(5,2),nullable=False,server_default="1"),sa.Column("starts_at",sa.DateTime(timezone=True),nullable=False),sa.Column("ends_at",sa.DateTime(timezone=True)),sa.Column("active",sa.Boolean(),nullable=False,server_default=sa.true()))
    op.create_index("ix_driver_incentives_zone_name","driver_incentives",["zone_name"]);op.create_index("ix_driver_incentives_active","driver_incentives",["active"])

    op.create_table("operational_incidents",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("order_id",sa.Integer(),sa.ForeignKey("orders.id")),sa.Column("incident_type",sa.String(80),nullable=False),sa.Column("severity",sa.String(20),nullable=False,server_default="medium"),sa.Column("title",sa.String(180),nullable=False),sa.Column("detail",sa.Text(),nullable=False,server_default=""),sa.Column("recommended_action",sa.String(400),nullable=False,server_default=""),sa.Column("status",sa.String(30),nullable=False,server_default="open"),sa.Column("assigned_to_user_id",sa.Integer(),sa.ForeignKey("users.id")),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.Column("resolved_at",sa.DateTime(timezone=True)))
    for c in ["order_id","incident_type","severity","status","created_at"]:op.create_index(f"ix_operational_incidents_{c}","operational_incidents",[c])

    op.create_table("marketing_automations",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("name",sa.String(180),nullable=False),sa.Column("trigger_type",sa.String(80),nullable=False),sa.Column("segment",sa.String(80),nullable=False,server_default="all"),sa.Column("channel",sa.String(30),nullable=False,server_default="in_app"),sa.Column("coupon_code",sa.String(50),nullable=False,server_default=""),sa.Column("message_template",sa.Text(),nullable=False,server_default=""),sa.Column("active",sa.Boolean(),nullable=False,server_default=sa.true()),sa.Column("last_run_at",sa.DateTime(timezone=True)),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_marketing_automations_trigger_type","marketing_automations",["trigger_type"]);op.create_index("ix_marketing_automations_active","marketing_automations",["active"])

    op.create_table("ingredient_stocks",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("restaurant_id",sa.Integer(),sa.ForeignKey("restaurants.id"),nullable=False),sa.Column("name",sa.String(140),nullable=False),sa.Column("unit",sa.String(30),nullable=False,server_default="unit"),sa.Column("quantity",sa.Numeric(12,3),nullable=False,server_default="0"),sa.Column("reorder_level",sa.Numeric(12,3),nullable=False,server_default="0"),sa.Column("unit_cost",sa.Numeric(10,2),nullable=False,server_default="0"),sa.Column("updated_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_ingredient_stocks_restaurant_id","ingredient_stocks",["restaurant_id"]);op.create_index("ix_ingredient_stocks_name","ingredient_stocks",["name"])
    op.create_table("menu_recipes",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("menu_item_id",sa.Integer(),sa.ForeignKey("menu_items.id"),nullable=False),sa.Column("ingredient_id",sa.Integer(),sa.ForeignKey("ingredient_stocks.id"),nullable=False),sa.Column("quantity_required",sa.Numeric(12,3),nullable=False,server_default="1"),sa.UniqueConstraint("menu_item_id","ingredient_id",name="uq_recipe_component"))
    op.create_index("ix_menu_recipes_menu_item_id","menu_recipes",["menu_item_id"]);op.create_index("ix_menu_recipes_ingredient_id","menu_recipes",["ingredient_id"])
    op.create_table("waste_records",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("restaurant_id",sa.Integer(),sa.ForeignKey("restaurants.id"),nullable=False),sa.Column("ingredient_id",sa.Integer(),sa.ForeignKey("ingredient_stocks.id")),sa.Column("quantity",sa.Numeric(12,3),nullable=False,server_default="0"),sa.Column("reason",sa.String(180),nullable=False,server_default=""),sa.Column("estimated_cost",sa.Numeric(10,2),nullable=False,server_default="0"),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_waste_records_restaurant_id","waste_records",["restaurant_id"]);op.create_index("ix_waste_records_created_at","waste_records",["created_at"])

    op.create_table("corporate_accounts",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("name",sa.String(180),nullable=False,unique=True),sa.Column("join_code",sa.String(30),nullable=False,unique=True),sa.Column("monthly_budget",sa.Numeric(12,2),nullable=False,server_default="0"),sa.Column("cost_center",sa.String(80),nullable=False,server_default="GENERAL"),sa.Column("active",sa.Boolean(),nullable=False,server_default=sa.true()),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_corporate_accounts_name","corporate_accounts",["name"]);op.create_index("ix_corporate_accounts_join_code","corporate_accounts",["join_code"])
    op.create_table("corporate_members",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("corporate_account_id",sa.Integer(),sa.ForeignKey("corporate_accounts.id"),nullable=False),sa.Column("user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),sa.Column("employee_code",sa.String(80),nullable=False,server_default=""),sa.Column("individual_budget",sa.Numeric(12,2),nullable=False,server_default="0"),sa.Column("active",sa.Boolean(),nullable=False,server_default=sa.true()),sa.UniqueConstraint("corporate_account_id","user_id",name="uq_corporate_member"))
    op.create_index("ix_corporate_members_corporate_account_id","corporate_members",["corporate_account_id"]);op.create_index("ix_corporate_members_user_id","corporate_members",["user_id"])
    op.add_column("orders", sa.Column("corporate_account_id", sa.Integer(), sa.ForeignKey("corporate_accounts.id"), nullable=True))
    op.create_index("ix_orders_corporate_account_id","orders",["corporate_account_id"])

    op.create_table("privacy_requests",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),sa.Column("request_type",sa.String(30),nullable=False),sa.Column("status",sa.String(30),nullable=False,server_default="pending"),sa.Column("result_json",sa.Text(),nullable=False,server_default="{}"),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.Column("completed_at",sa.DateTime(timezone=True)))
    for c in ["user_id","request_type","status"]:op.create_index(f"ix_privacy_requests_{c}","privacy_requests",[c])
    op.create_table("partner_api_keys",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("partner_name",sa.String(180),nullable=False),sa.Column("key_hash",sa.String(64),nullable=False,unique=True),sa.Column("scopes",sa.String(500),nullable=False,server_default="catalog:read,orders:read"),sa.Column("active",sa.Boolean(),nullable=False,server_default=sa.true()),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.Column("last_used_at",sa.DateTime(timezone=True)))
    op.create_index("ix_partner_api_keys_partner_name","partner_api_keys",["partner_name"]);op.create_index("ix_partner_api_keys_key_hash","partner_api_keys",["key_hash"])
    op.create_table("device_sessions",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),sa.Column("session_hash",sa.String(64),nullable=False),sa.Column("device_label",sa.String(200),nullable=False,server_default=""),sa.Column("ip_hint",sa.String(80),nullable=False,server_default=""),sa.Column("active",sa.Boolean(),nullable=False,server_default=sa.true()),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.Column("last_seen_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_device_sessions_user_id","device_sessions",["user_id"]);op.create_index("ix_device_sessions_session_hash","device_sessions",["session_hash"]);op.create_index("ix_device_sessions_active","device_sessions",["active"])
    op.create_table("group_carts",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("code",sa.String(12),nullable=False,unique=True),sa.Column("restaurant_id",sa.Integer(),sa.ForeignKey("restaurants.id"),nullable=False),sa.Column("owner_user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),sa.Column("locked",sa.Boolean(),nullable=False,server_default=sa.false()),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_group_carts_code","group_carts",["code"]);op.create_index("ix_group_carts_restaurant_id","group_carts",["restaurant_id"]);op.create_index("ix_group_carts_owner_user_id","group_carts",["owner_user_id"])
    op.create_table("group_cart_items",sa.Column("id",sa.Integer(),primary_key=True),sa.Column("group_cart_id",sa.Integer(),sa.ForeignKey("group_carts.id"),nullable=False),sa.Column("user_id",sa.Integer(),sa.ForeignKey("users.id"),nullable=False),sa.Column("menu_item_id",sa.Integer(),sa.ForeignKey("menu_items.id"),nullable=False),sa.Column("quantity",sa.Integer(),nullable=False,server_default="1"),sa.Column("options",sa.Text(),nullable=False,server_default=""),sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),sa.UniqueConstraint("group_cart_id","user_id","menu_item_id",name="uq_group_cart_user_item"))
    op.create_index("ix_group_cart_items_group_cart_id","group_cart_items",["group_cart_id"]);op.create_index("ix_group_cart_items_user_id","group_cart_items",["user_id"]);op.create_index("ix_group_cart_items_menu_item_id","group_cart_items",["menu_item_id"])


def downgrade():
    op.drop_column("orders","corporate_account_id")
    for table in ["group_cart_items","group_carts","device_sessions","partner_api_keys","privacy_requests","corporate_members","corporate_accounts","waste_records","menu_recipes","ingredient_stocks","marketing_automations","operational_incidents","driver_incentives","experiment_assignments","experiments","product_events"]:
        op.drop_table(table)
    for c in ["message_type","media_url","lat","lng"]: op.drop_column("chat_messages",c)
    for c in ["tier","streak_days","plus_savings"]: op.drop_column("loyalty_accounts",c)
    for c in ["recipient_name","recipient_phone","gift_message"]: op.drop_column("orders",c)
    for c in ["availability_schedule_json","price_schedule_json"]: op.drop_column("menu_items",c)
    op.drop_column("restaurants","market_code")
    for c in ["two_factor_enabled","totp_secret","marketing_opt_in","birth_date"]: op.drop_column("users",c)
