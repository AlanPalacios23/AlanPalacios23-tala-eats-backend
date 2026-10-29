-- RC13.5: physical cash custody handoff is distinct from bank settlement.
-- Additive, no backfill, no Stripe transfers and no modifications to orders.
CREATE TABLE finance_cash_handoffs_v2 (
 order_id INTEGER PRIMARY KEY REFERENCES orders(id),
 restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
 driver_user_id INTEGER NOT NULL REFERENCES users(id),
 expected_minor BIGINT NOT NULL CHECK(expected_minor>0 AND expected_minor<=100000000),
 handoff_code_hash VARCHAR(64) NOT NULL CHECK(handoff_code_hash ~ '^[0-9a-f]{64}$'),
 status VARCHAR(18) NOT NULL DEFAULT 'initiated' CHECK(status IN ('initiated','confirmed')),
 initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 acknowledged_by_owner_id INTEGER REFERENCES users(id),
 acknowledged_at TIMESTAMPTZ,
 CONSTRAINT finance_cash_handoff_ack_check CHECK (
  (status='initiated' AND acknowledged_by_owner_id IS NULL AND acknowledged_at IS NULL) OR
  (status='confirmed' AND acknowledged_by_owner_id IS NOT NULL AND acknowledged_at IS NOT NULL)
 )
);
CREATE INDEX finance_cash_handoff_v2_status ON finance_cash_handoffs_v2(status,initiated_at);
CREATE TABLE finance_cash_handoff_events_v2(
 id BIGSERIAL PRIMARY KEY,
 event_key VARCHAR(120) NOT NULL UNIQUE,
 order_id INTEGER NOT NULL REFERENCES finance_cash_handoffs_v2(order_id),
 actor_user_id INTEGER NOT NULL REFERENCES users(id),
 action VARCHAR(18) NOT NULL CHECK(action IN ('initiated','confirmed')),
 amount_minor BIGINT NOT NULL CHECK(amount_minor>0 AND amount_minor<=100000000),
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(order_id,action)
);
CREATE FUNCTION finance_cash_handoff_guard_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'CASH_HANDOFF_HISTORY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='finance_cash_handoff_events_v2' THEN
  RAISE EXCEPTION 'CASH_HANDOFF_EVENT_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF OLD.status='initiated' AND NEW.status='confirmed' AND
    NEW.order_id=OLD.order_id AND NEW.restaurant_id=OLD.restaurant_id AND
    NEW.driver_user_id=OLD.driver_user_id AND NEW.expected_minor=OLD.expected_minor AND
    NEW.handoff_code_hash=OLD.handoff_code_hash AND NEW.initiated_at=OLD.initiated_at AND
    NEW.acknowledged_by_owner_id IS NOT NULL AND NEW.acknowledged_at IS NOT NULL THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'CASH_HANDOFF_STATE_IMMUTABLE' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER finance_cash_handoff_v2_guard
 BEFORE UPDATE OR DELETE ON finance_cash_handoffs_v2
 FOR EACH ROW EXECUTE FUNCTION finance_cash_handoff_guard_v2();
CREATE TRIGGER finance_cash_handoff_event_v2_guard
 BEFORE UPDATE OR DELETE ON finance_cash_handoff_events_v2
 FOR EACH ROW EXECUTE FUNCTION finance_cash_handoff_guard_v2();
