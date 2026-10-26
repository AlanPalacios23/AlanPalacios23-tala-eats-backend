-- Isolated Node PostgreSQL only. Additive, no financial schema mutations.
-- Deploy separately after backup and Prisma migrate status on staging.
CREATE TABLE IF NOT EXISTS "web_push_deliveries" (
  "id" SERIAL NOT NULL,
  "notification_id" INTEGER NOT NULL,
  "subscription_id" INTEGER NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claim_until" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "last_error" VARCHAR(160) NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "web_push_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "web_push_deliveries_notification_id_subscription_id_key"
 ON "web_push_deliveries" ("notification_id","subscription_id");
CREATE INDEX IF NOT EXISTS "idx_web_push_retry"
 ON "web_push_deliveries" ("status","next_attempt_at");
