-- Fail-closed onboarding: prevent a raw SQL insert or a future Node route
-- from creating a driver marked verified by database default.
-- ADDITIVE / METADATA-ONLY migration on isolated PostgreSQL 15 staging.
-- Existing user rows and explicit staff approvals remain unchanged.
-- NEVER apply directly to Python PostgreSQL16 production.
ALTER TABLE "driver_profiles" ALTER COLUMN "is_verified" SET DEFAULT FALSE;
