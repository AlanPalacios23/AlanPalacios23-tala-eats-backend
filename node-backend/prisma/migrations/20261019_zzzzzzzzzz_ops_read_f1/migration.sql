-- F1 read-mostly operational reporting parity, disposable PG15 ONLY.
-- No changes to Python V3/GREEN, production ledger or live infrastructure.
CREATE TABLE service_zones (
 id SERIAL PRIMARY KEY, name VARCHAR(120) UNIQUE NOT NULL,
 center_lat DOUBLE PRECISION NOT NULL, center_lng DOUBLE PRECISION NOT NULL,
 radius_km DOUBLE PRECISION NOT NULL DEFAULT 8,
 surcharge NUMERIC(10,2) NOT NULL DEFAULT 0,
 min_order NUMERIC(10,2) NOT NULL DEFAULT 0,
 active BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX service_zones_active_idx ON service_zones(active);
CREATE TABLE feature_flags (
 id SERIAL PRIMARY KEY, key VARCHAR(100) UNIQUE NOT NULL,
 description VARCHAR(300) NOT NULL DEFAULT '',
 enabled BOOLEAN NOT NULL DEFAULT false,
 rollout_percent INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
 audience_role VARCHAR(30) NOT NULL DEFAULT 'all',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX feature_flags_enabled_idx ON feature_flags(enabled);
CREATE TABLE fraud_flags (
 id SERIAL PRIMARY KEY,
 user_id INTEGER REFERENCES users(id),order_id INTEGER REFERENCES orders(id),
 reason VARCHAR(300) NOT NULL,severity VARCHAR(20) NOT NULL DEFAULT 'medium',
 risk_score INTEGER NOT NULL DEFAULT 0,signal VARCHAR(80) NOT NULL DEFAULT 'rules',
 resolved BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX fraud_flags_user_id_idx ON fraud_flags(user_id);
CREATE INDEX fraud_flags_order_id_idx ON fraud_flags(order_id);
CREATE INDEX fraud_flags_resolved_idx ON fraud_flags(resolved);
CREATE TABLE verification_records (
 id SERIAL PRIMARY KEY,entity_type VARCHAR(30) NOT NULL,entity_id INTEGER NOT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'pending',
 notes VARCHAR(500) NOT NULL DEFAULT '',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX verification_records_entity_id_idx ON verification_records(entity_id);
CREATE TABLE operational_incidents(
 id SERIAL PRIMARY KEY,order_id INTEGER REFERENCES orders(id),
 incident_type VARCHAR(80) NOT NULL,severity VARCHAR(20) NOT NULL DEFAULT 'medium',
 title VARCHAR(180) NOT NULL,detail TEXT NOT NULL DEFAULT '',
 recommended_action VARCHAR(400) NOT NULL DEFAULT '',
 status VARCHAR(30) NOT NULL DEFAULT 'open',
 assigned_to_user_id INTEGER REFERENCES users(id),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 resolved_at TIMESTAMP(3)
);
CREATE INDEX operational_incidents_order_id_idx ON operational_incidents(order_id);
CREATE INDEX operational_incidents_status_idx ON operational_incidents(status);
