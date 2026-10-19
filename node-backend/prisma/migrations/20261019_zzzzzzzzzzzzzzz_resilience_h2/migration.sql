-- H2: isolated resilience audit/admin tables. No LIVE financial updates.
CREATE TABLE dead_letter_jobs(
 id SERIAL PRIMARY KEY,source VARCHAR(60) NOT NULL,
 source_id VARCHAR(120) NOT NULL DEFAULT '',
 kind VARCHAR(120) NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',
 error TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0,
 status VARCHAR(30) NOT NULL DEFAULT 'open',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 resolved_at TIMESTAMP(3)
);
CREATE INDEX dead_letter_jobs_source_idx ON dead_letter_jobs(source);
CREATE INDEX dead_letter_jobs_source_id_idx ON dead_letter_jobs(source_id);
CREATE INDEX dead_letter_jobs_kind_idx ON dead_letter_jobs(kind);
CREATE INDEX dead_letter_jobs_status_idx ON dead_letter_jobs(status);
CREATE INDEX dead_letter_jobs_created_at_idx ON dead_letter_jobs(created_at);
CREATE TABLE system_alerts(
 id SERIAL PRIMARY KEY,alert_key VARCHAR(160) NOT NULL,
 severity VARCHAR(20) NOT NULL DEFAULT 'warning',
 component VARCHAR(60) NOT NULL DEFAULT 'backend',
 message VARCHAR(500) NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',
 status VARCHAR(30) NOT NULL DEFAULT 'open',
 first_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 notified_at TIMESTAMP(3),resolved_at TIMESTAMP(3)
);
CREATE INDEX system_alerts_alert_key_idx ON system_alerts(alert_key);
CREATE INDEX system_alerts_severity_idx ON system_alerts(severity);
CREATE INDEX system_alerts_component_idx ON system_alerts(component);
CREATE INDEX system_alerts_status_idx ON system_alerts(status);
CREATE INDEX system_alerts_last_seen_at_idx ON system_alerts(last_seen_at);
CREATE UNIQUE INDEX system_alerts_one_open_key
 ON system_alerts(alert_key) WHERE status='open';
CREATE TABLE payment_reconciliations(
 id SERIAL PRIMARY KEY,provider VARCHAR(40) NOT NULL DEFAULT 'mercadopago',
 order_id INTEGER REFERENCES orders(id),
 provider_payment_id VARCHAR(160) NOT NULL DEFAULT '',
 local_status VARCHAR(40) NOT NULL DEFAULT '',
 provider_status VARCHAR(40) NOT NULL DEFAULT '',
 action VARCHAR(80) NOT NULL DEFAULT 'none',
 detail TEXT NOT NULL DEFAULT '',
 status VARCHAR(30) NOT NULL DEFAULT 'checked',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX payment_reconciliations_provider_idx ON payment_reconciliations(provider);
CREATE INDEX payment_reconciliations_order_id_idx ON payment_reconciliations(order_id);
CREATE INDEX payment_reconciliations_provider_payment_id_idx ON payment_reconciliations(provider_payment_id);
CREATE INDEX payment_reconciliations_action_idx ON payment_reconciliations(action);
CREATE INDEX payment_reconciliations_status_idx ON payment_reconciliations(status);
CREATE INDEX payment_reconciliations_created_at_idx ON payment_reconciliations(created_at);
