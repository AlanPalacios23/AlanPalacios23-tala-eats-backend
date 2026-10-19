-- Newly created staging PostgreSQL 15 ONLY.
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED','PROCESSED','FAILED');
CREATE TYPE "PayoutStatus" AS ENUM ('DRAFT','REQUIRES_REVIEW','APPROVED','SUBMITTED','RECONCILING','COMPLETED','FAILED');

CREATE TABLE "stripe_webhook_events" (
"id" TEXT NOT NULL, "type" TEXT NOT NULL,
"stripeAccountId" TEXT, "objectId" TEXT,
"status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
"deliveryCount" INTEGER NOT NULL DEFAULT 1,
"receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"processedAt" TIMESTAMP(3), "lastErrorAt" TIMESTAMP(3),
CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id"));

CREATE TABLE "merchant_connect_accounts" (
"id" TEXT NOT NULL, "merchantId" TEXT NOT NULL,
"stripeAccountId" TEXT NOT NULL,
"chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
"payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"updatedAt" TIMESTAMP(3) NOT NULL,
CONSTRAINT "merchant_connect_accounts_pkey" PRIMARY KEY ("id"));

CREATE TABLE "payout_instructions" (
"id" TEXT NOT NULL, "merchantId" TEXT NOT NULL,
"amountMinor" BIGINT NOT NULL,
"currency" TEXT NOT NULL DEFAULT 'mxn',
"idempotencyKey" TEXT NOT NULL,
"stripePayoutId" TEXT,
"status" "PayoutStatus" NOT NULL DEFAULT 'DRAFT',
"lastReconciledAt" TIMESTAMP(3),
"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"updatedAt" TIMESTAMP(3) NOT NULL,
CONSTRAINT "payout_instructions_pkey" PRIMARY KEY ("id"));

CREATE INDEX "stripe_webhook_events_status_receivedAt_idx" ON "stripe_webhook_events"("status", "receivedAt");
CREATE UNIQUE INDEX "merchant_connect_accounts_merchantId_key" ON "merchant_connect_accounts"("merchantId");
CREATE UNIQUE INDEX "merchant_connect_accounts_stripeAccountId_key" ON "merchant_connect_accounts"("stripeAccountId");
CREATE UNIQUE INDEX "payout_instructions_idempotencyKey_key" ON "payout_instructions"("idempotencyKey");
CREATE UNIQUE INDEX "payout_instructions_stripePayoutId_key" ON "payout_instructions"("stripePayoutId");
CREATE INDEX "payout_instructions_merchantId_status_idx" ON "payout_instructions"("merchantId", "status");
