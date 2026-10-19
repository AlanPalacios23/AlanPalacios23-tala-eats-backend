-- C2 isolated PG15-only lifecycle. Must run AFTER 20261019_z_cash_pickup_atomic_c1.
-- Never run against Python V3/GREEN/LIVE or unbacked Kali stage.
ALTER TABLE "orders" ADD COLUMN "cancelled_reason" VARCHAR(300) NOT NULL DEFAULT '';
