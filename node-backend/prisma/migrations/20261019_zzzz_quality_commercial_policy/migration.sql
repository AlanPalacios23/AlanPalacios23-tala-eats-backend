-- C4 quality gate, only in disposable/staging PostgreSQL15.
-- Mirrors Python SystemSetting fields; no migration of Python production data.
CREATE TABLE "system_settings" (
  "id" SERIAL PRIMARY KEY,
  "key" VARCHAR(100) NOT NULL UNIQUE,
  "value" VARCHAR(500) NOT NULL DEFAULT '',
  "value_type" VARCHAR(30) NOT NULL DEFAULT 'string',
  "description" VARCHAR(300) NOT NULL DEFAULT '',
  "updated_by_user_id" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
