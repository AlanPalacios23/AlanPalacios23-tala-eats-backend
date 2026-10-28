-- RC9.3: no money movement. One-time TOTP consumption for connected-account
-- identity mapping, owner approval and Stripe hosted onboarding.
-- ADDITIVE, independent of already deployed six Treasury RC9 tables.
-- A valid financial TOTP can be consumed only once per 30-second counter
-- across *all* Connect banking actions and concurrent API workers.
CREATE TABLE tala_live_connect_otp_consumptions (
 id BIGSERIAL PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 otp_counter BIGINT NOT NULL CHECK (otp_counter >= 0),
 purpose VARCHAR(32) NOT NULL DEFAULT 'bank_step_up'
   CHECK (purpose='bank_step_up'),
 consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT connect_otp_one_use_per_user_step UNIQUE(user_id,otp_counter)
);
CREATE INDEX connect_otp_consumptions_created
 ON tala_live_connect_otp_consumptions(consumed_at);
