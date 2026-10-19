-- E1 Customer platform. PostgreSQL15 isolated staging, NEVER Python V3/GREEN.
-- This migration runs after D1 and touches no existing production tables.
CREATE TABLE "addresses" (
 "id" SERIAL PRIMARY KEY,
 "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "label" VARCHAR(60) NOT NULL DEFAULT 'Casa',
 "address" VARCHAR(300) NOT NULL,
 "lat" DOUBLE PRECISION,
 "lng" DOUBLE PRECISION,
 "is_default" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX "addresses_user_id_idx" ON "addresses"("user_id");
CREATE INDEX "addresses_user_id_is_default_idx" ON "addresses"("user_id","is_default");
CREATE UNIQUE INDEX "one_default_address_per_user"
 ON "addresses"("user_id") WHERE "is_default" = true;
ALTER TABLE "addresses" ADD CONSTRAINT "address_length_range"
 CHECK (length("address") BETWEEN 5 AND 300);
ALTER TABLE "addresses" ADD CONSTRAINT "address_latitude_range"
 CHECK ("lat" IS NULL OR ("lat" BETWEEN -90 AND 90));
ALTER TABLE "addresses" ADD CONSTRAINT "address_longitude_range"
 CHECK ("lng" IS NULL OR ("lng" BETWEEN -180 AND 180));

CREATE TABLE "favorites" (
 "id" SERIAL PRIMARY KEY,
 "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "restaurant_id" INTEGER NOT NULL REFERENCES "restaurants"("id") ON DELETE CASCADE,
 CONSTRAINT "uq_customer_favorite_restaurant" UNIQUE ("user_id","restaurant_id")
);
CREATE INDEX "favorites_user_id_idx" ON "favorites"("user_id");
CREATE INDEX "favorites_restaurant_id_idx" ON "favorites"("restaurant_id");
