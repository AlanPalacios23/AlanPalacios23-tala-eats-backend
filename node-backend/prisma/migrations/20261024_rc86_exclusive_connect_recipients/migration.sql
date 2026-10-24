-- RC8.6: hard DB boundary for marketplace payee account identity.
-- Two independent payout account tables MUST share a single uniqueness rule,
-- including when parallel administrators submit the same account at once.
-- These are additive integrity guards; NO charge, transfer, payout or data move.

ALTER TABLE tala_live_merchant_accounts
  ADD CONSTRAINT rc86_merchant_real_restaurant
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE RESTRICT;
ALTER TABLE tala_live_merchant_accounts
  ADD CONSTRAINT rc86_merchant_real_registrar
  FOREIGN KEY (registered_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE tala_live_financial_cases
  ADD CONSTRAINT rc86_case_real_order
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT;
ALTER TABLE tala_live_settlement_proposals
  ADD CONSTRAINT rc86_settlement_real_order
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT;
ALTER TABLE tala_live_settlement_proposals
  ADD CONSTRAINT rc86_settlement_real_restaurant
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION tala_rc86_exclusive_connect_recipient()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stripe_account_id !~ '^acct_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'CONNECT_ID_INVALID' USING ERRCODE='23514';
  END IF;
  -- Every writer to EITHER table obtains this transaction-scoped lock.
  -- This prevents cross-table race conditions under READ COMMITTED.
  PERFORM pg_advisory_xact_lock(hashtextextended(
     'tala-connect-recipient:'||NEW.stripe_account_id, 8600));
  IF TG_TABLE_NAME='tala_live_merchant_accounts' THEN
    IF EXISTS (
      SELECT 1 FROM tala_live_driver_accounts
      WHERE stripe_account_id=NEW.stripe_account_id
    ) THEN
      RAISE EXCEPTION 'CONNECT_ACCOUNT_BELONGS_TO_DRIVER' USING ERRCODE='23505';
    END IF;
  ELSIF TG_TABLE_NAME='tala_live_driver_accounts' THEN
    IF EXISTS (
      SELECT 1 FROM tala_live_merchant_accounts
      WHERE stripe_account_id=NEW.stripe_account_id
    ) THEN
      RAISE EXCEPTION 'CONNECT_ACCOUNT_BELONGS_TO_RESTAURANT' USING ERRCODE='23505';
    END IF;
  ELSE
    RAISE EXCEPTION 'UNKNOWN_CONNECT_REGISTRY_TABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tala_rc86_merchant_connect_exclusive
 BEFORE INSERT OR UPDATE OF stripe_account_id
 ON tala_live_merchant_accounts
 FOR EACH ROW EXECUTE FUNCTION tala_rc86_exclusive_connect_recipient();

CREATE TRIGGER tala_rc86_driver_connect_exclusive
 BEFORE INSERT OR UPDATE OF stripe_account_id
 ON tala_live_driver_accounts
 FOR EACH ROW EXECUTE FUNCTION tala_rc86_exclusive_connect_recipient();

-- A same account must never be reused across roles on migration day.
-- Abort the migration transaction if any existing data violates this.
DO $$
BEGIN
 IF EXISTS(
   SELECT 1 FROM tala_live_merchant_accounts m
   JOIN tala_live_driver_accounts d USING(stripe_account_id)
 ) THEN
   RAISE EXCEPTION 'RC86_EXISTING_CROSS_ROLE_CONNECT_COLLISION';
 END IF;
END;
$$;
