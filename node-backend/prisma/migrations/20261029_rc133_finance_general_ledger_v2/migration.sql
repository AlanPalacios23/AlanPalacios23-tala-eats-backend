-- RC13.3 | additive-only, default-DORMANT general ledger foundation.
-- Never backfill old orders, move money or interpret this schema as bank cash.
-- The balance trigger is deferred until COMMIT so journal + postings can be
-- created atomically. A journal cannot persist without balancing postings.

CREATE TABLE finance_accounts_v2 (
 id BIGSERIAL PRIMARY KEY,
 account_key VARCHAR(120) NOT NULL UNIQUE,
 owner_kind VARCHAR(20) NOT NULL,
 owner_id INTEGER,
 category VARCHAR(40) NOT NULL,
 currency VARCHAR(3) NOT NULL DEFAULT 'mxn',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT finance_accounts_v2_key_check CHECK (account_key ~ '^[a-z][a-z0-9_.:-]{2,119}$'),
 CONSTRAINT finance_accounts_v2_owner_check CHECK (
  (owner_kind IN ('platform','external') AND owner_id IS NULL) OR
  (owner_kind IN ('restaurant','driver','customer') AND owner_id>0)
 ),
 CONSTRAINT finance_accounts_v2_currency_check CHECK (currency='mxn'),
 CONSTRAINT finance_accounts_v2_category_check CHECK (
  category IN ('asset','liability','revenue','expense','equity','clearing')
 )
);
CREATE TABLE finance_journals_v2 (
 id BIGSERIAL PRIMARY KEY,
 event_key VARCHAR(180) NOT NULL UNIQUE,
 fingerprint VARCHAR(64) NOT NULL,
 source_type VARCHAR(30) NOT NULL,
 source_ref VARCHAR(120) NOT NULL,
 description VARCHAR(200) NOT NULL,
 currency VARCHAR(3) NOT NULL DEFAULT 'mxn',
 status VARCHAR(16) NOT NULL DEFAULT 'building',
 reversal_of_id BIGINT REFERENCES finance_journals_v2(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT finance_journals_v2_source_type_check CHECK (
  source_type IN ('order','delivery','cash_handoff','stripe_event','bank_event',
   'settlement','refund','dispute','adjustment')
 ),
 CONSTRAINT finance_journals_v2_status_check CHECK(status IN ('building','posted')),
 CONSTRAINT finance_journals_v2_currency_check CHECK(currency='mxn'),
 CONSTRAINT finance_journals_v2_fingerprint_check CHECK (
  fingerprint ~ '^[0-9a-f]{64}$'
 ),
 CONSTRAINT finance_journals_v2_event_check CHECK(
  event_key ~ '^[a-zA-Z0-9_.:-]{8,180}$'
 ),
 CONSTRAINT finance_journals_v2_source_ref_check CHECK (
  source_ref ~ '^[a-zA-Z0-9_.:-]{1,120}$'
 )
);
CREATE INDEX finance_journals_v2_source ON finance_journals_v2(source_type,source_ref);
CREATE TABLE finance_postings_v2 (
 id BIGSERIAL PRIMARY KEY,
 journal_id BIGINT NOT NULL REFERENCES finance_journals_v2(id),
 line_no SMALLINT NOT NULL CHECK(line_no BETWEEN 1 AND 64),
 account_id BIGINT NOT NULL REFERENCES finance_accounts_v2(id),
 debit_minor BIGINT NOT NULL DEFAULT 0,
 credit_minor BIGINT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT finance_postings_v2_one_direction CHECK (
  (debit_minor>0 AND credit_minor=0 AND debit_minor<=9000000000000) OR
  (credit_minor>0 AND debit_minor=0 AND credit_minor<=9000000000000)
 ),
 CONSTRAINT finance_postings_v2_unique_line UNIQUE(journal_id,line_no)
);
CREATE INDEX finance_postings_v2_account ON finance_postings_v2(account_id,journal_id);

-- No historical row may be rewritten to counterfeit an external receipt.
CREATE FUNCTION finance_v2_reject_row_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'FINANCE_V2_IMMUTABLE_DELETE' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='finance_journals_v2' AND
    OLD.status='building' AND NEW.status='posted' AND
    NEW.event_key=OLD.event_key AND NEW.fingerprint=OLD.fingerprint AND
    NEW.source_type=OLD.source_type AND NEW.source_ref=OLD.source_ref AND
    NEW.description=OLD.description AND NEW.currency=OLD.currency AND
    NEW.reversal_of_id IS NOT DISTINCT FROM OLD.reversal_of_id AND
    NEW.created_at=OLD.created_at THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'FINANCE_V2_IMMUTABLE_UPDATE' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER finance_v2_accounts_immutable
 BEFORE UPDATE OR DELETE ON finance_accounts_v2
 FOR EACH ROW EXECUTE FUNCTION finance_v2_reject_row_mutation();
CREATE TRIGGER finance_v2_journals_immutable
 BEFORE UPDATE OR DELETE ON finance_journals_v2
 FOR EACH ROW EXECUTE FUNCTION finance_v2_reject_row_mutation();
CREATE TRIGGER finance_v2_postings_immutable
 BEFORE UPDATE OR DELETE ON finance_postings_v2
 FOR EACH ROW EXECUTE FUNCTION finance_v2_reject_row_mutation();

-- New postings can be added only while the journal is BUILDING in the same
-- uncommitted transaction, and only to an account with matching currency.
CREATE FUNCTION finance_v2_validate_posting_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE j_status TEXT; j_currency TEXT; a_currency TEXT;
BEGIN
 SELECT status,currency INTO j_status,j_currency FROM finance_journals_v2
 WHERE id=NEW.journal_id FOR UPDATE;
 IF j_status IS DISTINCT FROM 'building' THEN
  RAISE EXCEPTION 'FINANCE_V2_JOURNAL_SEALED' USING ERRCODE='23514';
 END IF;
 SELECT currency INTO a_currency FROM finance_accounts_v2
 WHERE id=NEW.account_id;
 IF a_currency IS DISTINCT FROM j_currency THEN
  RAISE EXCEPTION 'FINANCE_V2_CURRENCY_MISMATCH' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER finance_v2_posting_currency
 BEFORE INSERT ON finance_postings_v2
 FOR EACH ROW EXECUTE FUNCTION finance_v2_validate_posting_insert();

-- Deferred balance check executes on the FINAL state of the journal.
CREATE FUNCTION finance_v2_require_balanced() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT; v_state TEXT; v_lines BIGINT;
 v_debit NUMERIC; v_credit NUMERIC;
BEGIN
 IF TG_TABLE_NAME='finance_journals_v2' THEN
  v_id := NEW.id;
 ELSE
  v_id := NEW.journal_id;
 END IF;
 SELECT status INTO v_state FROM finance_journals_v2 WHERE id=v_id;
 IF v_state IS DISTINCT FROM 'posted' THEN
  RAISE EXCEPTION 'FINANCE_V2_JOURNAL_NOT_POSTED' USING ERRCODE='23514';
 END IF;
 SELECT COUNT(*),COALESCE(SUM(debit_minor),0),COALESCE(SUM(credit_minor),0)
 INTO v_lines,v_debit,v_credit FROM finance_postings_v2 WHERE journal_id=v_id;
 IF v_lines<2 OR v_debit<>v_credit OR v_debit<=0 THEN
  RAISE EXCEPTION 'FINANCE_V2_UNBALANCED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_v2_journal_balance
 AFTER INSERT OR UPDATE ON finance_journals_v2
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION finance_v2_require_balanced();
CREATE CONSTRAINT TRIGGER finance_v2_posting_balance
 AFTER INSERT ON finance_postings_v2
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION finance_v2_require_balanced();

-- Never run "INSERT FROM old ledger" automatically. Backfill requires
-- independent cross-check and scoped approval. No tables here contain
-- Stripe keys, bank identifiers, full names, RFC, fiscal XML, or card data.
