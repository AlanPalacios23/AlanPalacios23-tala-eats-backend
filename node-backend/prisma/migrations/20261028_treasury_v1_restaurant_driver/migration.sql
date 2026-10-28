-- TALA EATS TREASURY v1 — ADDITIVE SHADOW SCHEMA ONLY.
-- Two payees: restaurant and driver. Applying the migration does not move funds.
-- Activation requires a separate audited release; LIVE transfer/payout flags remain OFF.
CREATE TABLE IF NOT EXISTS tala_live_treasury_transfers (
  id BIGSERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  payee_kind VARCHAR(12) NOT NULL,
  payee_id INTEGER NOT NULL,
  connected_account_id VARCHAR(120) NOT NULL,
  source_charge_id VARCHAR(120) NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'mxn',
  state VARCHAR(24) NOT NULL DEFAULT 'reserved',
  idempotency_key VARCHAR(150) NOT NULL UNIQUE,
  stripe_transfer_id VARCHAR(120) UNIQUE,
  reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT treasury_transfer_unique_payee UNIQUE(order_id,payee_kind,payee_id),
  CONSTRAINT treasury_transfer_payee_chk CHECK(payee_kind IN ('restaurant','driver') AND payee_id>0),
  CONSTRAINT treasury_transfer_money_chk CHECK(amount_minor>0 AND currency='mxn'),
  CONSTRAINT treasury_transfer_account_chk CHECK(connected_account_id ~ '^acct_[A-Za-z0-9]+$'
    AND source_charge_id ~ '^ch_[A-Za-z0-9]+$'),
  CONSTRAINT treasury_transfer_state_chk CHECK(state IN
    ('reserved','submitted','unknown','completed','reversed','manual_hold')),
  CONSTRAINT treasury_transfer_proven_chk CHECK(
    state NOT IN ('completed','reversed') OR stripe_transfer_id ~ '^tr_[A-Za-z0-9]+$'),
  CONSTRAINT treasury_transfer_approvers_chk CHECK(
    reviewed_by_user_id IS NULL OR approved_by_user_id IS NULL OR
    reviewed_by_user_id<>approved_by_user_id)
);
CREATE INDEX IF NOT EXISTS treasury_transfers_recipient
  ON tala_live_treasury_transfers(payee_kind,payee_id,state,created_at);
CREATE TABLE IF NOT EXISTS tala_live_treasury_withdrawals (
  id BIGSERIAL PRIMARY KEY,
  payee_kind VARCHAR(12) NOT NULL,
  payee_id INTEGER NOT NULL,
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connected_account_id VARCHAR(120) NOT NULL,
  bank_destination_id VARCHAR(120) NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'mxn',
  client_key VARCHAR(96) NOT NULL,
  totp_step BIGINT NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'reserved',
  stripe_payout_id VARCHAR(120) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT treasury_withdrawal_unique_request UNIQUE(payee_kind,payee_id,client_key),
  CONSTRAINT treasury_withdrawal_unique_otp UNIQUE(requested_by_user_id,totp_step),
  CONSTRAINT treasury_withdrawal_payee_chk CHECK(payee_kind IN ('restaurant','driver') AND payee_id>0),
  CONSTRAINT treasury_withdrawal_money_chk CHECK(amount_minor>=100 AND currency='mxn'),
  CONSTRAINT treasury_withdrawal_account_chk CHECK(
    connected_account_id ~ '^acct_[A-Za-z0-9]+$'
    AND bank_destination_id ~ '^ba_[A-Za-z0-9]+$'),
  CONSTRAINT treasury_withdrawal_state_chk CHECK(state IN
    ('reserved','submitted','unknown','paid','failed','canceled','review_required')),
  CONSTRAINT treasury_withdrawal_proven_chk CHECK(
    state NOT IN ('paid','failed','canceled') OR stripe_payout_id ~ '^po_[A-Za-z0-9]+$')
);
CREATE INDEX IF NOT EXISTS treasury_withdrawals_recipient
  ON tala_live_treasury_withdrawals(payee_kind,payee_id,created_at DESC);
-- Limit one unknown/in-flight request per payee; retain terminal ledger for life.
CREATE UNIQUE INDEX IF NOT EXISTS treasury_single_pending_withdrawal
  ON tala_live_treasury_withdrawals(payee_kind,payee_id)
  WHERE state IN ('reserved','submitted','unknown','review_required');
CREATE TABLE IF NOT EXISTS tala_live_treasury_events (
  event_id VARCHAR(180) PRIMARY KEY,
  connected_account_id VARCHAR(120) NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  stripe_object_id VARCHAR(120) NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'received',
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reconciled_at TIMESTAMPTZ,
  CONSTRAINT treasury_event_state_chk CHECK(state IN ('received','processed','review_required'))
);
CREATE INDEX IF NOT EXISTS treasury_events_review ON tala_live_treasury_events(state,received_at);
-- Never re-label held allocations as paid, create synthetic Connect balances,
-- enable auto payouts, call Stripe or mutate existing live orders here.

-- Append-only bank payout posting. A paid event is posted ONCE per request.
CREATE TABLE IF NOT EXISTS tala_live_treasury_ledger (
 id BIGSERIAL PRIMARY KEY,
 withdrawal_id BIGINT NOT NULL REFERENCES tala_live_treasury_withdrawals(id) ON DELETE RESTRICT,
 event_id VARCHAR(180) NOT NULL REFERENCES tala_live_treasury_events(event_id) ON DELETE RESTRICT,
 kind VARCHAR(30) NOT NULL,
 amount_minor BIGINT NOT NULL,
 currency VARCHAR(3) NOT NULL DEFAULT 'mxn',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT treasury_ledger_unique_posting UNIQUE(withdrawal_id,kind),
 CONSTRAINT treasury_ledger_event_unique UNIQUE(event_id),
 CONSTRAINT treasury_ledger_kind_chk CHECK(kind='bank_payout_paid'),
 CONSTRAINT treasury_ledger_money_chk CHECK(amount_minor>=100 AND currency='mxn')
);
CREATE INDEX IF NOT EXISTS treasury_ledger_created ON tala_live_treasury_ledger(created_at);
