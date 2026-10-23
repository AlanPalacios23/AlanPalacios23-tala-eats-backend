-- RC8.4: production finance safety; additive, no payment or transfer writes.
-- Applied ONLY to the dedicated production database after verified backup.
CREATE TABLE IF NOT EXISTS tala_live_merchant_accounts (
  restaurant_id INTEGER PRIMARY KEY,
  stripe_account_id VARCHAR(120) NOT NULL UNIQUE,
  registered_by_user_id INTEGER NOT NULL,
  owner_approved_at TIMESTAMPTZ,
  settlement_policy VARCHAR(24) NOT NULL DEFAULT 'manual_hold',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT live_merchant_stripe_acct_chk CHECK (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  CONSTRAINT live_merchant_policy_chk CHECK (settlement_policy IN ('manual_hold','reviewed_release'))
);
CREATE TABLE IF NOT EXISTS tala_live_financial_cases (
  id BIGSERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL,
  case_type VARCHAR(30) NOT NULL,
  stripe_object_id VARCHAR(120) NOT NULL,
  last_event_id VARCHAR(120) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  evidence_ref VARCHAR(300),
  reviewed_by_user_id INTEGER,
  resolved_by_user_id INTEGER,
  reviewed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT live_case_kind_chk CHECK (case_type IN ('refund','refund_failure','dispute','charge_refund')),
  CONSTRAINT live_case_status_chk CHECK (status IN ('open','reviewed','resolved')),
  CONSTRAINT live_case_resolution_chk CHECK (status<>'resolved' OR
    (reviewed_at IS NOT NULL AND resolved_at IS NOT NULL AND
     reviewed_by_user_id IS NOT NULL AND resolved_by_user_id IS NOT NULL AND
     reviewed_by_user_id<>resolved_by_user_id AND
     evidence_ref IS NOT NULL AND LENGTH(evidence_ref)>=12)),
  CONSTRAINT live_case_unique UNIQUE (case_type,stripe_object_id)
);
CREATE INDEX IF NOT EXISTS ix_live_cases_open ON tala_live_financial_cases (status,order_id);
CREATE TABLE IF NOT EXISTS tala_live_settlement_proposals (
  id BIGSERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE,
  restaurant_id INTEGER NOT NULL,
  stripe_account_id VARCHAR(120) NOT NULL,
  charge_id VARCHAR(120) NOT NULL,
  proposed_amount_minor BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'MXN',
  state VARCHAR(24) NOT NULL DEFAULT 'manual_hold',
  reason VARCHAR(120) NOT NULL,
  prepared_by_user_id INTEGER NOT NULL,
  reviewed_by_user_id INTEGER,
  reviewed_at TIMESTAMPTZ,
  approved_by_user_id INTEGER,
  approved_at TIMESTAMPTZ,
  stripe_transfer_id VARCHAR(120) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT live_proposal_amount_chk CHECK(proposed_amount_minor>0),
  CONSTRAINT live_proposal_state_chk CHECK(state IN
   ('manual_hold','under_review','approved','transferred','canceled')),
  CONSTRAINT live_proposal_no_implicit_transfer_chk CHECK(
    (state='transferred' AND stripe_transfer_id IS NOT NULL) OR
    (state<>'transferred' AND stripe_transfer_id IS NULL)),
  CONSTRAINT live_proposal_approvers_chk CHECK(
    state NOT IN ('approved','transferred') OR
    (reviewed_by_user_id IS NOT NULL AND approved_by_user_id IS NOT NULL AND
     reviewed_by_user_id<>approved_by_user_id))
);
CREATE INDEX IF NOT EXISTS ix_live_proposals_review ON tala_live_settlement_proposals(state,restaurant_id);
-- No ALTER of existing orders/ledger, and no Stripe transfer automatically.
