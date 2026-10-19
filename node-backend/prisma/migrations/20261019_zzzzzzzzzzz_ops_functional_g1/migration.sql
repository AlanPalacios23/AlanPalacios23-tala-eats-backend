-- G1: isolated Python operational parity, PG15 CI ONLY. NEVER migrate Python LIVE.
CREATE TABLE onboarding_applications (
 id SERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
 entity_type VARCHAR(30) NOT NULL,business_name VARCHAR(160) NOT NULL DEFAULT '',
 tax_id VARCHAR(60) NOT NULL DEFAULT '',vehicle VARCHAR(100) NOT NULL DEFAULT '',
 documents_json TEXT NOT NULL DEFAULT '[]',payout_account_ref VARCHAR(180) NOT NULL DEFAULT '',
 status VARCHAR(30) NOT NULL DEFAULT 'pending',notes TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT onboarding_type_valid CHECK(entity_type IN ('restaurant','driver'))
);
CREATE INDEX onboarding_applications_user_id_idx ON onboarding_applications(user_id);
CREATE INDEX onboarding_applications_status_idx ON onboarding_applications(status);
-- Guarantee one active onboarding request per user/type. The Python reader
-- used application-level checks, but Node must prevent cross-worker races.
CREATE UNIQUE INDEX onboarding_only_one_active_per_user
 ON onboarding_applications(user_id,entity_type)
 WHERE status IN ('pending','needs_info','approved');
CREATE TABLE disputes (
 id SERIAL PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),
 opened_by_user_id INTEGER NOT NULL REFERENCES users(id),
 category VARCHAR(80) NOT NULL,description TEXT NOT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'open',resolution TEXT NOT NULL DEFAULT '',
 refund_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
 assigned_to_user_id INTEGER REFERENCES users(id),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 resolved_at TIMESTAMP(3)
);
CREATE INDEX disputes_order_id_idx ON disputes(order_id);
CREATE INDEX disputes_opened_by_user_id_idx ON disputes(opened_by_user_id);
CREATE INDEX disputes_status_idx ON disputes(status);
CREATE TABLE sponsored_campaigns (
 id SERIAL PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
 name VARCHAR(150) NOT NULL,daily_budget NUMERIC(10,2) NOT NULL DEFAULT 100,
 spent NUMERIC(10,2) NOT NULL DEFAULT 0,impressions INTEGER NOT NULL DEFAULT 0,
 clicks INTEGER NOT NULL DEFAULT 0,attributed_orders INTEGER NOT NULL DEFAULT 0,
 active BOOLEAN NOT NULL DEFAULT true,starts_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ends_at TIMESTAMP(3)
);
CREATE INDEX sponsored_campaigns_restaurant_id_idx ON sponsored_campaigns(restaurant_id);
CREATE TABLE simulation_runs (
 id SERIAL PRIMARY KEY,created_by_user_id INTEGER NOT NULL REFERENCES users(id),
 scenario VARCHAR(80) NOT NULL DEFAULT 'happy_path',
 status VARCHAR(30) NOT NULL DEFAULT 'created',
 current_step VARCHAR(60) NOT NULL DEFAULT 'customer_order',
 state_json TEXT NOT NULL DEFAULT '{}',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX simulation_runs_created_by_user_id_idx ON simulation_runs(created_by_user_id);
CREATE INDEX simulation_runs_status_idx ON simulation_runs(status);
CREATE TABLE payouts (
 id SERIAL PRIMARY KEY,payee_type VARCHAR(30) NOT NULL,payee_id INTEGER NOT NULL,
 amount NUMERIC(12,2) NOT NULL,currency VARCHAR(8) NOT NULL DEFAULT 'MXN',
 period_start TIMESTAMP(3) NOT NULL,period_end TIMESTAMP(3) NOT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'pending',provider_ref VARCHAR(180) NOT NULL DEFAULT '',
 provider VARCHAR(40) NOT NULL DEFAULT 'manual',attempts INTEGER NOT NULL DEFAULT 0,
 failure_reason VARCHAR(500) NOT NULL DEFAULT '',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,paid_at TIMESTAMP(3)
);
CREATE INDEX payouts_payee_type_payee_id_idx ON payouts(payee_type,payee_id);
CREATE INDEX payouts_status_idx ON payouts(status);
CREATE TABLE cash_settlements(
 id SERIAL PRIMARY KEY,driver_id INTEGER NOT NULL REFERENCES users(id),
 period_label VARCHAR(60) NOT NULL DEFAULT '',
 cash_collected NUMERIC(12,2) NOT NULL DEFAULT 0,
 driver_earnings NUMERIC(12,2) NOT NULL DEFAULT 0,
 amount_due_platform NUMERIC(12,2) NOT NULL DEFAULT 0,
 status VARCHAR(30) NOT NULL DEFAULT 'open',notes VARCHAR(400) NOT NULL DEFAULT '',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 settled_at TIMESTAMP(3)
);
CREATE INDEX cash_settlements_driver_id_idx ON cash_settlements(driver_id);
CREATE INDEX cash_settlements_status_idx ON cash_settlements(status);
