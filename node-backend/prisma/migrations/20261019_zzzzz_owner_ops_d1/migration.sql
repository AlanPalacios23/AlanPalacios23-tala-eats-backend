-- D1: Python owner.py analytics + employee membership. PostgreSQL15 staging ONLY.
-- Apply only after C4 migrations, never to Python V3/GREEN or Kali LIVE.
-- Unique pair is a deliberate hardening of Python's check-then-insert race.
CREATE TABLE "restaurant_employees" (
  "id" SERIAL PRIMARY KEY,
  "restaurant_id" INTEGER NOT NULL REFERENCES "restaurants"("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" VARCHAR(30) NOT NULL DEFAULT 'cashier',
  CONSTRAINT "uq_restaurant_employee_membership" UNIQUE ("restaurant_id","user_id"),
  CONSTRAINT "restaurant_employee_role_allowed" CHECK("role" IN ('manager','cashier','kitchen'))
);
CREATE INDEX "restaurant_employees_restaurant_id_idx" ON "restaurant_employees"("restaurant_id");
CREATE INDEX "restaurant_employees_user_id_idx" ON "restaurant_employees"("user_id");
