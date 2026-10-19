-- H3 never on Kali/Python production.
CREATE TABLE experiments(
 id SERIAL PRIMARY KEY,key VARCHAR(100) NOT NULL UNIQUE,
 name VARCHAR(180) NOT NULL,variants_json TEXT NOT NULL DEFAULT '["control","variant"]',
 audience_role VARCHAR(30) NOT NULL DEFAULT 'customer',
 rollout_percent INTEGER NOT NULL DEFAULT 100 CHECK(rollout_percent BETWEEN 0 AND 100),
 status VARCHAR(30) NOT NULL DEFAULT 'draft',
 primary_metric VARCHAR(100) NOT NULL DEFAULT 'checkout_completed',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX experiments_status_idx ON experiments(status);
CREATE TABLE experiment_assignments(
 id SERIAL PRIMARY KEY,experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id),
 variant VARCHAR(60) NOT NULL,created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT uq_experiment_user UNIQUE(experiment_id,user_id)
);
CREATE INDEX experiment_assignments_user_id_idx ON experiment_assignments(user_id);
CREATE TABLE partner_api_keys(
 id SERIAL PRIMARY KEY,partner_name VARCHAR(180) NOT NULL,key_hash VARCHAR(64) NOT NULL UNIQUE,
 scopes VARCHAR(500) NOT NULL DEFAULT 'catalog:read',active BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,last_used_at TIMESTAMP(3)
);
CREATE INDEX partner_api_keys_partner_name_idx ON partner_api_keys(partner_name);
