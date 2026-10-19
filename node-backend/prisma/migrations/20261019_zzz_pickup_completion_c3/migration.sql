-- C3 isolated PostgreSQL15 staging only. NOT FOR PYTHON production.
-- Always migrate on disposable or explicitly backed up staging DB.
CREATE TABLE "delivery_proofs"(
 "id" SERIAL PRIMARY KEY,
 "order_id" INTEGER NOT NULL UNIQUE REFERENCES "orders"("id"),
 "driver_id" INTEGER NOT NULL REFERENCES "users"("id"),
 "pin_verified" BOOLEAN NOT NULL DEFAULT false,
 "photo_url" VARCHAR(600) NOT NULL DEFAULT '',
 "lat" DOUBLE PRECISION,
 "lng" DOUBLE PRECISION,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "delivery_proofs_driver_id_idx" ON "delivery_proofs"("driver_id");
CREATE TABLE "product_events"(
 "id" SERIAL PRIMARY KEY,
 "user_id" INTEGER REFERENCES "users"("id"),
 "session_id" VARCHAR(80) NOT NULL DEFAULT '',
 "event_name" VARCHAR(100) NOT NULL,
 "route" VARCHAR(240) NOT NULL DEFAULT '',
 "properties_json" TEXT NOT NULL DEFAULT '{}',
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "product_events_user_id_idx" ON "product_events"("user_id");
CREATE INDEX "product_events_session_id_idx" ON "product_events"("session_id");
CREATE INDEX "product_events_event_name_idx" ON "product_events"("event_name");
CREATE INDEX "product_events_created_at_idx" ON "product_events"("created_at");
