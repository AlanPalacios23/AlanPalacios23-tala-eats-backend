-- E2 commercial discovery and reviews in disposable PG15 staging only.
-- No coupon redemption, wallet changes, PSP/payment or production migrations.
CREATE TABLE "promotions"(
 "id" SERIAL PRIMARY KEY,
 "restaurant_id" INTEGER REFERENCES "restaurants"("id") ON DELETE SET NULL,
 "title" VARCHAR(150) NOT NULL,
 "description" VARCHAR(300) NOT NULL DEFAULT '',
 "discount_percent" INTEGER NOT NULL DEFAULT 10,
 "active" BOOLEAN NOT NULL DEFAULT true,
 "sponsored" BOOLEAN NOT NULL DEFAULT false,
 CONSTRAINT "promotion_percent_valid" CHECK ("discount_percent" BETWEEN 0 AND 100)
);
CREATE INDEX "promotions_restaurant_id_idx" ON "promotions"("restaurant_id");
CREATE INDEX "promotions_active_sponsored_idx" ON "promotions"("active","sponsored");

CREATE TABLE "coupons"(
 "id" SERIAL PRIMARY KEY,
 "code" VARCHAR(50) NOT NULL UNIQUE,
 "discount_type" VARCHAR(20) NOT NULL DEFAULT 'percent',
 "value" DECIMAL(10,2) NOT NULL DEFAULT 10.00,
 "min_order" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "active" BOOLEAN NOT NULL DEFAULT true,
 "description" VARCHAR(200) NOT NULL DEFAULT '',
 CONSTRAINT "coupon_value_nonnegative" CHECK ("value">=0 AND "min_order">=0)
);
CREATE TABLE "reviews" (
 "id" SERIAL PRIMARY KEY,
 "order_id" INTEGER NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
 "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "restaurant_id" INTEGER NOT NULL REFERENCES "restaurants"("id") ON DELETE CASCADE,
 "driver_id" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
 "restaurant_rating" INTEGER NOT NULL,
 "driver_rating" INTEGER,
 "comment" TEXT NOT NULL DEFAULT '',
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "uq_review_order_customer" UNIQUE ("order_id","user_id"),
 CONSTRAINT "restaurant_rating_valid" CHECK ("restaurant_rating" BETWEEN 1 AND 5),
 CONSTRAINT "driver_rating_valid" CHECK ("driver_rating" IS NULL OR "driver_rating" BETWEEN 1 AND 5)
);
CREATE INDEX "reviews_order_id_idx" ON "reviews"("order_id");
CREATE INDEX "reviews_user_id_idx" ON "reviews"("user_id");
CREATE INDEX "reviews_restaurant_id_idx" ON "reviews"("restaurant_id");
