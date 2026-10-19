-- H1: V11 private capabilities, PG15 disposable test DB only.
CREATE TABLE push_subscriptions (
 id SERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
 endpoint VARCHAR(1200) NOT NULL,
 p256dh VARCHAR(300) NOT NULL DEFAULT '',auth VARCHAR(300) NOT NULL DEFAULT '',
 platform VARCHAR(40) NOT NULL DEFAULT 'web',
 device_label VARCHAR(200) NOT NULL DEFAULT '',
 active BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT uq_push_user_endpoint UNIQUE(user_id,endpoint)
);
CREATE INDEX push_subscriptions_active_idx ON push_subscriptions(active);
CREATE INDEX push_subscriptions_endpoint_idx ON push_subscriptions(endpoint);
CREATE TABLE substitution_requests (
 id SERIAL PRIMARY KEY,
 order_id INTEGER NOT NULL REFERENCES orders(id),
 order_item_id INTEGER NOT NULL REFERENCES order_items(id),
 restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
 requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
 replacement_menu_item_id INTEGER REFERENCES menu_items(id),
 issue_type VARCHAR(40) NOT NULL DEFAULT 'unavailable',
 message VARCHAR(500) NOT NULL DEFAULT '',
 original_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
 replacement_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
 status VARCHAR(30) NOT NULL DEFAULT 'pending',
 resolution TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TIMESTAMP(3),resolved_at TIMESTAMP(3)
);
CREATE INDEX substitution_requests_order_id_idx ON substitution_requests(order_id);
CREATE INDEX substitution_requests_order_item_id_idx ON substitution_requests(order_item_id);
CREATE INDEX substitution_requests_restaurant_id_idx ON substitution_requests(restaurant_id);
CREATE INDEX substitution_requests_requested_by_user_id_idx ON substitution_requests(requested_by_user_id);
CREATE INDEX substitution_requests_status_idx ON substitution_requests(status);
CREATE TABLE refund_adjustments (
 id SERIAL PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),
 created_by_user_id INTEGER REFERENCES users(id),
 amount NUMERIC(10,2) NOT NULL DEFAULT 0,
 reason VARCHAR(300) NOT NULL DEFAULT '',
 provider VARCHAR(40) NOT NULL DEFAULT '',provider_ref VARCHAR(220) NOT NULL DEFAULT '',
 status VARCHAR(30) NOT NULL DEFAULT 'pending',
 idempotency_key VARCHAR(180) NOT NULL UNIQUE,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,completed_at TIMESTAMP(3)
);
CREATE INDEX refund_adjustments_order_id_idx ON refund_adjustments(order_id);
CREATE INDEX refund_adjustments_created_by_user_id_idx ON refund_adjustments(created_by_user_id);
CREATE INDEX refund_adjustments_status_idx ON refund_adjustments(status);
