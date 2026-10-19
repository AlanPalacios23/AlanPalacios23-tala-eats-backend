-- Phase B PG15 staging-only. NEVER execute against Python production V3/GREEN.
-- No payments, payouts or money-moving routines are defined in this migration.
CREATE TABLE "restaurants" (
 "id" SERIAL PRIMARY KEY,
 "name" VARCHAR(150) NOT NULL, "description" TEXT NOT NULL DEFAULT '',
 "cuisine" VARCHAR(100) NOT NULL DEFAULT 'Comida local',
 "emoji" VARCHAR(20) NOT NULL DEFAULT '🍽️',
 "eta_min" INTEGER NOT NULL DEFAULT 30,
 "delivery_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "is_open" BOOLEAN NOT NULL DEFAULT true,
 "owner_id" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
 "lat" DOUBLE PRECISION NOT NULL DEFAULT 20.6534,
 "lng" DOUBLE PRECISION NOT NULL DEFAULT -103.704,
 "address" VARCHAR(300) NOT NULL DEFAULT '',
 "delivery_radius_km" DOUBLE PRECISION NOT NULL DEFAULT 8,
 "per_km_fee" DECIMAL(10,2) NOT NULL DEFAULT 4,
 "pickup_enabled" BOOLEAN NOT NULL DEFAULT true,
 "sponsored" BOOLEAN NOT NULL DEFAULT false,
 "rating" DECIMAL(3,2) NOT NULL DEFAULT 4.80,
 "verification_status" VARCHAR(30) NOT NULL DEFAULT 'verified',
 "pos_webhook_url" VARCHAR(600) NOT NULL DEFAULT '',
 "tax_id" VARCHAR(40) NOT NULL DEFAULT '',
 "commercial_plan" VARCHAR(30) NOT NULL DEFAULT 'START',
 "commission_rate" DECIMAL(6,4) NOT NULL DEFAULT 0.1200,
 "service_fee_rate" DECIMAL(6,4) NOT NULL DEFAULT 0.0400,
 "service_fee_fixed" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "branch_code" VARCHAR(40) NOT NULL DEFAULT 'MAIN',
 "brand_name" VARCHAR(150) NOT NULL DEFAULT '',
 "market_code" VARCHAR(40) NOT NULL DEFAULT 'TALA-JAL',
 "onboarding_status" VARCHAR(30) NOT NULL DEFAULT 'approved',
 "cover_image_url" VARCHAR(600) NOT NULL DEFAULT '',
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "restaurants_owner_id_idx" ON "restaurants"("owner_id");
CREATE INDEX "restaurants_market_code_idx" ON "restaurants"("market_code");
CREATE INDEX "restaurants_is_open_name_idx" ON "restaurants"("is_open","name");

CREATE TABLE "menu_items" (
 "id" SERIAL PRIMARY KEY,
 "restaurant_id" INTEGER NOT NULL REFERENCES "restaurants"("id") ON DELETE CASCADE,
 "name" VARCHAR(150) NOT NULL, "description" TEXT NOT NULL DEFAULT '',
 "category" VARCHAR(100) NOT NULL DEFAULT 'General',
 "price" DECIMAL(10,2) NOT NULL,
 "is_available" BOOLEAN NOT NULL DEFAULT true,
 "stock" INTEGER NOT NULL DEFAULT 100,
 "dietary_tags" VARCHAR(300) NOT NULL DEFAULT '',
 "allergens" VARCHAR(300) NOT NULL DEFAULT '',
 "is_combo" BOOLEAN NOT NULL DEFAULT false,
 "options_json" TEXT NOT NULL DEFAULT '[]',
 "availability_schedule_json" TEXT NOT NULL DEFAULT '{}',
 "price_schedule_json" TEXT NOT NULL DEFAULT '{}',
 "image_url" VARCHAR(600) NOT NULL DEFAULT ''
);
CREATE INDEX "menu_items_restaurant_id_idx" ON "menu_items"("restaurant_id");

CREATE TABLE "driver_profiles" (
 "id" SERIAL PRIMARY KEY, "user_id" INTEGER NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
 "vehicle" VARCHAR(80) NOT NULL DEFAULT 'Motocicleta', "plate" VARCHAR(30) NOT NULL DEFAULT '',
 "is_online" BOOLEAN NOT NULL DEFAULT false, "is_verified" BOOLEAN NOT NULL DEFAULT true,
 "rating" DECIMAL(3,2) NOT NULL DEFAULT 5.00,
 "total_deliveries" INTEGER NOT NULL DEFAULT 0,
 "current_lat" DOUBLE PRECISION, "current_lng" DOUBLE PRECISION,
 "earnings_today" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "driver_profiles_is_online_idx" ON "driver_profiles"("is_online");

CREATE TABLE "orders" (
 "id" SERIAL PRIMARY KEY,
 "user_id" INTEGER NOT NULL REFERENCES "users"("id"),
 "restaurant_id" INTEGER NOT NULL REFERENCES "restaurants"("id"),
 "driver_id" INTEGER REFERENCES "users"("id"),
 "status" VARCHAR(40) NOT NULL DEFAULT 'received',
 "payment_method" VARCHAR(30) NOT NULL DEFAULT 'cash',
 "payment_status" VARCHAR(30) NOT NULL DEFAULT 'pending',
 "payment_provider" VARCHAR(30) NOT NULL DEFAULT '',
 "payment_provider_id" VARCHAR(120) NOT NULL DEFAULT '',
 "payment_preference_id" VARCHAR(160) NOT NULL DEFAULT '',
 "subtotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "delivery_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "tip" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "total" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "platform_commission" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "service_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "payment_processing_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "refunded_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "promotion_subsidy" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "platform_revenue" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "contribution_margin" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "cash_collected" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "cancellation_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "restaurant_payout" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "driver_earning" DECIMAL(10,2) NOT NULL DEFAULT 0,
 "address" VARCHAR(300) NOT NULL, "notes" TEXT NOT NULL DEFAULT '',
 "delivery_pin" VARCHAR(4) NOT NULL DEFAULT '',
 "order_type" VARCHAR(20) NOT NULL DEFAULT 'delivery',
 "scheduled_for" TIMESTAMP(3), "coupon_code" VARCHAR(50) NOT NULL DEFAULT '',
 "group_code" VARCHAR(12) NOT NULL DEFAULT '',
 "recipient_name" VARCHAR(120) NOT NULL DEFAULT '',
 "recipient_phone" VARCHAR(40) NOT NULL DEFAULT '',
 "gift_message" VARCHAR(300) NOT NULL DEFAULT '',
 "corporate_account_id" INTEGER,
 "distance_km" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
 "delivery_lat" DOUBLE PRECISION, "delivery_lng" DOUBLE PRECISION,
 "estimated_minutes" INTEGER NOT NULL DEFAULT 30,
 "invoice_requested" BOOLEAN NOT NULL DEFAULT false,
 "invoice_tax_id" VARCHAR(40) NOT NULL DEFAULT '',
 "client_reference" VARCHAR(80),
 "accepted_at" TIMESTAMP(3), "preparing_at" TIMESTAMP(3),
 "ready_at" TIMESTAMP(3), "picked_up_at" TIMESTAMP(3),
 "delivered_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "uq_order_user_client_reference" UNIQUE ("user_id","client_reference")
);
CREATE INDEX "orders_user_id_created_at_idx" ON "orders"("user_id","created_at");
CREATE INDEX "orders_restaurant_id_status_idx" ON "orders"("restaurant_id","status");
CREATE INDEX "orders_driver_id_status_idx" ON "orders"("driver_id","status");

CREATE TABLE "order_items" (
 "id" SERIAL PRIMARY KEY,
 "order_id" INTEGER NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
 "menu_item_id" INTEGER REFERENCES "menu_items"("id") ON DELETE SET NULL,
 "name_snapshot" VARCHAR(150) NOT NULL,
 "quantity" INTEGER NOT NULL,
 "unit_price" DECIMAL(10,2) NOT NULL,
 "options_snapshot" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");
