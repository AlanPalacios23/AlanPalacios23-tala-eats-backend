-- G3: isolated PG15 V9 collaboration/consent. NO production data.
CREATE TABLE group_carts (
 id SERIAL PRIMARY KEY,code VARCHAR(12) NOT NULL UNIQUE,
 restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
 owner_user_id INTEGER NOT NULL REFERENCES users(id),
 locked BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX group_carts_restaurant_id_idx ON group_carts(restaurant_id);
CREATE INDEX group_carts_owner_user_id_idx ON group_carts(owner_user_id);
CREATE TABLE group_cart_items(
 id SERIAL PRIMARY KEY,
 group_cart_id INTEGER NOT NULL REFERENCES group_carts(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id),
 menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
 quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 20),
 options TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT uq_group_cart_user_item UNIQUE(group_cart_id,user_id,menu_item_id)
);
CREATE INDEX group_cart_items_group_cart_id_idx ON group_cart_items(group_cart_id);
CREATE INDEX group_cart_items_user_id_idx ON group_cart_items(user_id);
CREATE INDEX group_cart_items_menu_item_id_idx ON group_cart_items(menu_item_id);
CREATE TABLE corporate_accounts(
 id SERIAL PRIMARY KEY,name VARCHAR(180) NOT NULL UNIQUE,
 join_code VARCHAR(30) NOT NULL UNIQUE,
 monthly_budget NUMERIC(12,2) NOT NULL DEFAULT 0,
 cost_center VARCHAR(80) NOT NULL DEFAULT 'GENERAL',
 active BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE corporate_members(
 id SERIAL PRIMARY KEY,
 corporate_account_id INTEGER NOT NULL REFERENCES corporate_accounts(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id),
 employee_code VARCHAR(80) NOT NULL DEFAULT '',
 individual_budget NUMERIC(12,2) NOT NULL DEFAULT 0,
 active BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT uq_corporate_member UNIQUE(corporate_account_id,user_id)
);
CREATE INDEX corporate_members_user_id_idx ON corporate_members(user_id);
CREATE TABLE privacy_requests(
 id SERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
 request_type VARCHAR(30) NOT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'pending',
 result_json TEXT NOT NULL DEFAULT '{}',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 completed_at TIMESTAMP(3),
 CONSTRAINT privacy_type_valid CHECK(request_type IN ('export','delete','marketing_opt_out'))
);
CREATE INDEX privacy_requests_user_id_idx ON privacy_requests(user_id);
CREATE INDEX privacy_requests_request_type_idx ON privacy_requests(request_type);
CREATE INDEX privacy_requests_status_idx ON privacy_requests(status);
CREATE TABLE marketing_automations(
 id SERIAL PRIMARY KEY,name VARCHAR(180) NOT NULL,
 trigger_type VARCHAR(80) NOT NULL,
 segment VARCHAR(80) NOT NULL DEFAULT 'all',
 channel VARCHAR(30) NOT NULL DEFAULT 'in_app',
 coupon_code VARCHAR(50) NOT NULL DEFAULT '',
 message_template TEXT NOT NULL DEFAULT '',
 active BOOLEAN NOT NULL DEFAULT true,
 last_run_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX marketing_automations_trigger_type_idx ON marketing_automations(trigger_type);
CREATE INDEX marketing_automations_active_idx ON marketing_automations(active);
CREATE TABLE driver_incentives(
 id SERIAL PRIMARY KEY,zone_name VARCHAR(120) NOT NULL DEFAULT 'General',
 title VARCHAR(180) NOT NULL,
 bonus_per_delivery NUMERIC(10,2) NOT NULL DEFAULT 0,
 multiplier NUMERIC(5,2) NOT NULL DEFAULT 1,
 starts_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ends_at TIMESTAMP(3),active BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX driver_incentives_zone_name_idx ON driver_incentives(zone_name);
CREATE INDEX driver_incentives_active_idx ON driver_incentives(active);
