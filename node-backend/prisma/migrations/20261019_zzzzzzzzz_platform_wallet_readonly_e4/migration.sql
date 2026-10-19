-- E4: read-only customer wallet/history for ephemeral CI PostgreSQL15.
-- NO LIVE wallet writes, fund movements, payout or Python production migrations.
CREATE TABLE "wallet_transactions" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id"),
  "kind" VARCHAR(40) NOT NULL,
  "amount" NUMERIC(10,2) NOT NULL,
  "balance_after" NUMERIC(10,2) NOT NULL,
  "reference_type" VARCHAR(40) NOT NULL DEFAULT '',
  "reference_id" VARCHAR(120) NOT NULL DEFAULT '',
  "description" VARCHAR(300) NOT NULL DEFAULT '',
  "idempotency_key" VARCHAR(180) UNIQUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "wallet_transactions_user_id_created_at_idx"
 ON "wallet_transactions"("user_id","created_at");
CREATE INDEX "wallet_transactions_kind_idx" ON "wallet_transactions"("kind");
