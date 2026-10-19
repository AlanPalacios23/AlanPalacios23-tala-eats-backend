-- E1 isolated Node platform tables; PostgreSQL15 staging only.
-- NEVER apply to Python V3/GREEN, Kali LIVE or a database without backup.
CREATE TABLE "addresses" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "label" VARCHAR(60) NOT NULL DEFAULT 'Casa',
  "address" VARCHAR(300) NOT NULL,
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "address_nonempty" CHECK (LENGTH(TRIM(address))>=5),
  CONSTRAINT "address_lat_valid" CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  CONSTRAINT "address_lng_valid" CHECK (lng IS NULL OR (lng BETWEEN -180 AND 180))
);
CREATE INDEX "addresses_user_id_idx" ON "addresses"("user_id");
CREATE UNIQUE INDEX "addresses_one_default_per_user"
  ON "addresses"("user_id") WHERE "is_default" IS TRUE;

CREATE TABLE "favorites"(
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "restaurant_id" INTEGER NOT NULL REFERENCES "restaurants"("id") ON DELETE CASCADE,
  CONSTRAINT "uq_favorite" UNIQUE("user_id","restaurant_id")
);
CREATE INDEX "favorites_user_id_idx" ON "favorites"("user_id");
CREATE INDEX "favorites_restaurant_id_idx" ON "favorites"("restaurant_id");
