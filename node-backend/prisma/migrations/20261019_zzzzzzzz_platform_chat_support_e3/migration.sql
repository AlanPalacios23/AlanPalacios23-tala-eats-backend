-- E3: dependent on canonical reviews/promotions E2; PostgreSQL15 staging ONLY.
CREATE TABLE "chat_messages"(
  "id" SERIAL PRIMARY KEY,
  "order_id" INTEGER NOT NULL REFERENCES "orders"("id"),
  "sender_id" INTEGER NOT NULL REFERENCES "users"("id"),
  "message" VARCHAR(1000) NOT NULL DEFAULT '',
  "message_type" VARCHAR(30) NOT NULL DEFAULT 'text',
  "media_url" VARCHAR(600) NOT NULL DEFAULT '',
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_message_type_valid" CHECK ("message_type" IN ('text','photo','location','quick')),
  CONSTRAINT "chat_lat_valid" CHECK ("lat" IS NULL OR ("lat" BETWEEN -90 AND 90)),
  CONSTRAINT "chat_lng_valid" CHECK ("lng" IS NULL OR ("lng" BETWEEN -180 AND 180))
);
CREATE INDEX "chat_messages_order_id_created_at_idx" ON "chat_messages"("order_id","created_at");
CREATE INDEX "chat_messages_sender_id_idx" ON "chat_messages"("sender_id");
CREATE TABLE "support_tickets"(
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id"),
  "order_id" INTEGER REFERENCES "orders"("id"),
  "category" VARCHAR(80) NOT NULL,
  "message" TEXT NOT NULL CHECK (LENGTH(message) BETWEEN 5 AND 3000),
  "status" VARCHAR(30) NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "support_tickets_user_id_created_at_idx" ON "support_tickets"("user_id","created_at");
CREATE INDEX "support_tickets_order_id_idx" ON "support_tickets"("order_id");
