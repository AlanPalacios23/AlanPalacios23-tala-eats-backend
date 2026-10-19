-- Phase A: NEW NATIVE STAGING DB ONLY. Never run on V3/Green.
CREATE TABLE "users" (
 "id" SERIAL NOT NULL PRIMARY KEY,
 "name" VARCHAR(120) NOT NULL,
 "email" VARCHAR(255) NOT NULL,
 "password_hash" VARCHAR(500),
 "role" VARCHAR(30) NOT NULL DEFAULT 'customer',
 "auth_provider" VARCHAR(30) NOT NULL DEFAULT 'local',
 "google_sub" VARCHAR(255),
 "avatar_url" VARCHAR(600),
 "phone" VARCHAR(30) NOT NULL DEFAULT '',
 "is_active" BOOLEAN NOT NULL DEFAULT true,
 "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
 "totp_secret" VARCHAR(80) NOT NULL DEFAULT '',
 "marketing_opt_in" BOOLEAN NOT NULL DEFAULT true,
 "analytics_opt_in" BOOLEAN NOT NULL DEFAULT true,
 "personalization_opt_in" BOOLEAN NOT NULL DEFAULT true,
 "birth_date" VARCHAR(10) NOT NULL DEFAULT '',
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");
CREATE INDEX "users_role_idx" ON "users"("role");

CREATE TABLE "device_sessions" (
 "id" SERIAL NOT NULL PRIMARY KEY,
 "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "session_hash" VARCHAR(64) NOT NULL,
 "device_id_hash" VARCHAR(64) NOT NULL DEFAULT '',
 "device_label" VARCHAR(200) NOT NULL DEFAULT '',
 "platform" VARCHAR(40) NOT NULL DEFAULT 'unknown',
 "ip_hint" VARCHAR(80) NOT NULL DEFAULT '',
 "risk_score" INTEGER NOT NULL DEFAULT 0,
 "trusted" BOOLEAN NOT NULL DEFAULT false,
 "active" BOOLEAN NOT NULL DEFAULT true,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "device_sessions_session_hash_key" ON "device_sessions"("session_hash");
CREATE INDEX "device_sessions_user_id_created_at_idx" ON "device_sessions"("user_id","created_at");
CREATE INDEX "device_sessions_device_id_hash_idx" ON "device_sessions"("device_id_hash");

CREATE TABLE "loyalty_accounts" (
 "id" SERIAL NOT NULL PRIMARY KEY,
 "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "points" INTEGER NOT NULL DEFAULT 0,
 "tier" VARCHAR(20) NOT NULL DEFAULT 'BRONZE',
 "streak_days" INTEGER NOT NULL DEFAULT 0,
 "plus_savings" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
 "wallet_balance" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
 "plus_member" BOOLEAN NOT NULL DEFAULT false,
 "referral_code" VARCHAR(20) NOT NULL
);
CREATE UNIQUE INDEX "loyalty_accounts_user_id_key" ON "loyalty_accounts"("user_id");
CREATE UNIQUE INDEX "loyalty_accounts_referral_code_key" ON "loyalty_accounts"("referral_code");

CREATE TABLE "notifications" (
 "id" SERIAL NOT NULL PRIMARY KEY,
 "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "kind" VARCHAR(50) NOT NULL DEFAULT 'system',
 "title" VARCHAR(150) NOT NULL,
 "message" VARCHAR(500) NOT NULL,
 "is_read" BOOLEAN NOT NULL DEFAULT false,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id","created_at");

CREATE TABLE "audit_events" (
 "id" SERIAL NOT NULL PRIMARY KEY,
 "user_id" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
 "action" VARCHAR(100) NOT NULL,
 "entity_type" VARCHAR(80) NOT NULL DEFAULT '',
 "entity_id" VARCHAR(120) NOT NULL DEFAULT '',
 "detail" TEXT NOT NULL DEFAULT '',
 "before_json" TEXT NOT NULL DEFAULT '{}',
 "after_json" TEXT NOT NULL DEFAULT '{}',
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "device_session_id" INTEGER REFERENCES "device_sessions"("id") ON DELETE SET NULL
);
CREATE INDEX "audit_events_user_id_created_at_idx" ON "audit_events"("user_id","created_at");

CREATE TABLE "password_reset_tokens" (
 "id" SERIAL NOT NULL PRIMARY KEY,
 "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "token_hash" VARCHAR(64) NOT NULL,
 "expires_at" TIMESTAMP(3) NOT NULL,
 "used_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

CREATE TABLE "email_outbox" (
 "id" SERIAL NOT NULL PRIMARY KEY,
 "to_email" VARCHAR(255) NOT NULL,
 "subject" VARCHAR(220) NOT NULL,
 "text_body" TEXT NOT NULL,
 "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
 "attempts" INTEGER NOT NULL DEFAULT 0,
 "last_error" VARCHAR(500) NOT NULL DEFAULT '',
 "sent_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "email_outbox_status_created_at_idx" ON "email_outbox"("status","created_at");
