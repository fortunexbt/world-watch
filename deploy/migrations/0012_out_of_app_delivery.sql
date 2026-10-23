CREATE INDEX IF NOT EXISTS alert_deliveries_rule ON alert_deliveries(rule_id,state,created_at);
CREATE TABLE IF NOT EXISTS push_subscriptions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,endpoint TEXT NOT NULL UNIQUE,p256dh TEXT NOT NULL,auth TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_outbox(delivery_id TEXT NOT NULL,subscription_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(delivery_id,subscription_id));
CREATE INDEX IF NOT EXISTS push_outbox_created ON push_outbox(created_at);
