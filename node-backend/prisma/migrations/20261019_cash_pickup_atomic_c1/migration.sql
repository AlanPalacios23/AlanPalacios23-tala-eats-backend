-- Synthetic-only PG15 phase C. NEVER apply to Python/V3/GREEN or financial LIVE.
-- Python model names mapped exactly. No network/payment credentials.
CREATE TABLE "order_events"(
 "id" SERIAL PRIMARY KEY,
 "order_id" INTEGER NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
 "status" VARCHAR(40) NOT NULL,
 "actor_user_id" INTEGER REFERENCES "users"("id"),
 "metadata_json" TEXT NOT NULL DEFAULT '{}',
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "order_events_order_id_idx" ON "order_events"("order_id");
CREATE INDEX "order_events_status_idx" ON "order_events"("status");

CREATE TABLE "financial_ledger_entries"(
 "id" SERIAL PRIMARY KEY,
 "order_id" INTEGER REFERENCES "orders"("id"),
 "user_id" INTEGER REFERENCES "users"("id"),
 "restaurant_id" INTEGER REFERENCES "restaurants"("id"),
 "account" VARCHAR(60) NOT NULL,
 "direction" VARCHAR(10) NOT NULL DEFAULT 'credit',
 "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
 "currency" VARCHAR(8) NOT NULL DEFAULT 'MXN',
 "kind" VARCHAR(60) NOT NULL,
 "description" VARCHAR(300) NOT NULL DEFAULT '',
 "idempotency_key" VARCHAR(180) NOT NULL UNIQUE,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ledger_amount_nonnegative" CHECK ("amount">=0),
 CONSTRAINT "ledger_direction_known" CHECK ("direction" IN ('credit','debit'))
);
CREATE INDEX "financial_ledger_entries_order_id_idx" ON "financial_ledger_entries"("order_id");
CREATE INDEX "financial_ledger_entries_user_id_idx" ON "financial_ledger_entries"("user_id");
CREATE INDEX "financial_ledger_entries_restaurant_id_idx" ON "financial_ledger_entries"("restaurant_id");
CREATE INDEX "financial_ledger_entries_account_idx" ON "financial_ledger_entries"("account");
CREATE INDEX "financial_ledger_entries_kind_idx" ON "financial_ledger_entries"("kind");
CREATE INDEX "financial_ledger_entries_created_at_idx" ON "financial_ledger_entries"("created_at");
CREATE OR REPLACE FUNCTION tala_stage_ledger_no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'STAGE_IMMUTABLE_LEDGER: use compensating entries, never update/delete';
END $$;
CREATE TRIGGER financial_ledger_immutable BEFORE UPDATE OR DELETE ON "financial_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION tala_stage_ledger_no_mutation();

CREATE TABLE "event_outbox"(
 "id" SERIAL PRIMARY KEY,
 "event_key" VARCHAR(220) NOT NULL UNIQUE,
 "aggregate_type" VARCHAR(60) NOT NULL,
 "aggregate_id" VARCHAR(120) NOT NULL,
 "event_type" VARCHAR(120) NOT NULL,
 "payload_json" TEXT NOT NULL DEFAULT '{}',
 "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
 "attempts" INTEGER NOT NULL DEFAULT 0,
 "next_attempt_at" TIMESTAMP(3),
 "locked_at" TIMESTAMP(3),
 "last_error" VARCHAR(1000) NOT NULL DEFAULT '',
 "published_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "event_outbox_event_key_idx" ON "event_outbox"("event_key");
CREATE INDEX "event_outbox_aggregate_type_idx" ON "event_outbox"("aggregate_type");
CREATE INDEX "event_outbox_aggregate_id_idx" ON "event_outbox"("aggregate_id");
CREATE INDEX "event_outbox_event_type_idx" ON "event_outbox"("event_type");
CREATE INDEX "event_outbox_status_idx" ON "event_outbox"("status");
CREATE INDEX "event_outbox_next_attempt_at_idx" ON "event_outbox"("next_attempt_at");
CREATE INDEX "event_outbox_published_at_idx" ON "event_outbox"("published_at");
CREATE INDEX "event_outbox_created_at_idx" ON "event_outbox"("created_at");

CREATE TABLE "ingredient_stocks" (
 "id" SERIAL PRIMARY KEY,
 "restaurant_id" INTEGER NOT NULL REFERENCES "restaurants"("id") ON DELETE CASCADE,
 "name" VARCHAR(140) NOT NULL,
 "unit" VARCHAR(30) NOT NULL DEFAULT 'unit',
 "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
 "reorder_level" DECIMAL(12,3) NOT NULL DEFAULT 0,
 "unit_cost" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ingredient_nonnegative" CHECK ("quantity">=0)
);
CREATE INDEX "ingredient_stocks_restaurant_id_idx" ON "ingredient_stocks"("restaurant_id");
CREATE INDEX "ingredient_stocks_name_idx" ON "ingredient_stocks"("name");

CREATE TABLE "menu_recipes" (
 "id" SERIAL PRIMARY KEY,
 "menu_item_id" INTEGER NOT NULL REFERENCES "menu_items"("id") ON DELETE CASCADE,
 "ingredient_id" INTEGER NOT NULL REFERENCES "ingredient_stocks"("id") ON DELETE CASCADE,
 "quantity_required" DECIMAL(12,3) NOT NULL DEFAULT 1,
 CONSTRAINT "uq_recipe_component" UNIQUE ("menu_item_id","ingredient_id"),
 CONSTRAINT "recipe_quantity_positive" CHECK ("quantity_required">0)
);
CREATE INDEX "menu_recipes_menu_item_id_idx" ON "menu_recipes"("menu_item_id");
CREATE INDEX "menu_recipes_ingredient_id_idx" ON "menu_recipes"("ingredient_id");

ALTER TABLE "orders"
 ADD COLUMN "inventory_reserved_json" TEXT NOT NULL DEFAULT '{}',
 ADD COLUMN "inventory_restored_at" TIMESTAMP(3);
