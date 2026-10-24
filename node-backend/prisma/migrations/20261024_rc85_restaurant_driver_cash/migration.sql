-- RC8.5: Payable allocation and physical cash custody per order / beneficiary.
-- Install only on independently provisioned PostgreSQL, after tested backup.
-- NO transfer, payout, charge, or automatic cash settlement is triggered.
CREATE TABLE IF NOT EXISTS tala_live_driver_accounts (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
 stripe_account_id VARCHAR(120) NOT NULL UNIQUE,
 registered_by_user_id INTEGER NOT NULL REFERENCES users(id),
 owner_approved_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT rc85_driver_acct_format CHECK (stripe_account_id ~ '^acct_[A-Za-z0-9]+$')
);
CREATE TABLE IF NOT EXISTS tala_live_payee_allocations (
 id BIGSERIAL PRIMARY KEY,
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 payee_kind VARCHAR(12) NOT NULL,
 payee_id INTEGER NOT NULL,
 amount_minor BIGINT NOT NULL,
 tender VARCHAR(8) NOT NULL,
 fulfillment VARCHAR(22) NOT NULL,
 state VARCHAR(16) NOT NULL DEFAULT 'held',
 captured_evidence_ref VARCHAR(180),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(order_id,payee_kind),
 CONSTRAINT rc85_kind CHECK (payee_kind IN ('restaurant','driver')),
 CONSTRAINT rc85_tender CHECK (tender IN ('stripe','cash')),
 CONSTRAINT rc85_fulfillment CHECK (fulfillment IN ('pickup','platform_delivery','merchant_delivery')),
 CONSTRAINT rc85_amount CHECK (amount_minor>0 AND amount_minor<=100000000),
 CONSTRAINT rc85_state CHECK (state IN ('held','reviewed','settled','reversed')),
 CONSTRAINT rc85_no_driver_for_pickup CHECK (payee_kind<>'driver' OR fulfillment='platform_delivery')
);
CREATE INDEX IF NOT EXISTS rc85_allocations_payee ON tala_live_payee_allocations(payee_kind,payee_id,state);
CREATE TABLE IF NOT EXISTS tala_live_cash_custody (
 order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
 collector_kind VARCHAR(12) NOT NULL,
 collector_id INTEGER NOT NULL,
 collected_minor BIGINT NOT NULL,
 retained_minor BIGINT NOT NULL,
 due_platform_minor BIGINT NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'awaiting_evidence',
 evidence_ref VARCHAR(300),
 submitted_by INTEGER REFERENCES users(id),
 reviewed_by INTEGER REFERENCES users(id),
 settled_by INTEGER REFERENCES users(id),
 submitted_at TIMESTAMPTZ,
 reviewed_at TIMESTAMPTZ,
 settled_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT rc85_collector_kind CHECK (collector_kind IN ('restaurant','driver')),
 CONSTRAINT rc85_cash_amount CHECK (
   collected_minor>0 AND retained_minor>=0
   AND due_platform_minor>=0 AND retained_minor+due_platform_minor=collected_minor),
 CONSTRAINT rc85_cash_status CHECK (status IN
    ('awaiting_evidence','submitted','reviewed','settled','disputed')),
 CONSTRAINT rc85_cash_review CHECK (
   status NOT IN ('reviewed','settled') OR
   (submitted_by IS NOT NULL AND reviewed_by IS NOT NULL
    AND submitted_by<>reviewed_by AND evidence_ref IS NOT NULL
    AND LENGTH(evidence_ref)>=12)),
 CONSTRAINT rc85_cash_settle CHECK (
   status<>'settled' OR
   (settled_by IS NOT NULL AND settled_by<>reviewed_by AND settled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS rc85_cash_status_idx ON tala_live_cash_custody(status,created_at);
-- This schema records accounting expectations, never claims actual cash received
-- until an operator explicitly records and independently reviews evidence.
