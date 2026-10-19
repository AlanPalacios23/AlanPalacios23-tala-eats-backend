-- J1: isolated stage-only extensions. Never run against Python production.
CREATE TABLE gift_cards(
 id SERIAL PRIMARY KEY,code VARCHAR(50) UNIQUE NOT NULL,
 balance NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK(balance>=0),
 active BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE driver_offers(
 id SERIAL PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),
 driver_id INTEGER NOT NULL REFERENCES users(id),round_no INTEGER NOT NULL DEFAULT 1,
 score DOUBLE PRECISION NOT NULL DEFAULT 0,
 estimated_pickup_min INTEGER NOT NULL DEFAULT 5,
 estimated_earning NUMERIC(10,2) NOT NULL DEFAULT 0,
 status VARCHAR(20) NOT NULL DEFAULT 'offered',
 offered_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TIMESTAMP(3) NOT NULL,responded_at TIMESTAMP(3),
 CONSTRAINT uq_offer_round UNIQUE(order_id,driver_id,round_no)
);
CREATE INDEX driver_offers_driver_status_idx ON driver_offers(driver_id,status);
CREATE INDEX driver_offers_order_status_idx ON driver_offers(order_id,status);
CREATE TABLE media_assets(
 id SERIAL PRIMARY KEY,filename VARCHAR(180) NOT NULL UNIQUE,
 category VARCHAR(50) NOT NULL,
 user_id INTEGER NOT NULL REFERENCES users(id),
 order_id INTEGER REFERENCES orders(id),
 restaurant_id INTEGER REFERENCES restaurants(id),
 menu_item_id INTEGER REFERENCES menu_items(id),
 mime VARCHAR(60) NOT NULL,
 bytes INTEGER NOT NULL,
 attached BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX media_assets_user_category_idx ON media_assets(user_id,category);
CREATE INDEX media_assets_order_id_idx ON media_assets(order_id);

CREATE TABLE referral_conversions(
 id SERIAL PRIMARY KEY,
 referrer_user_id INTEGER NOT NULL REFERENCES users(id),
 referred_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
 referral_code VARCHAR(30) NOT NULL,
 reward_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
 status VARCHAR(30) NOT NULL DEFAULT 'pending',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX referral_conversions_referrer_user_id_idx ON referral_conversions(referrer_user_id);
