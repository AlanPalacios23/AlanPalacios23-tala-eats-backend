-- Stripe-only Node staging; no refund/payout or provider migration.
-- Retain historical rows for auditing: change ONLY the default of future
-- reconciliation rows. Python V3/GREEN uses an entirely different database.
ALTER TABLE payment_reconciliations
  ALTER COLUMN provider SET DEFAULT 'stripe';
