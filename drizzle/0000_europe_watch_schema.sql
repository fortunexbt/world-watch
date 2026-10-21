-- Custom schema-only migration generated through drizzle-kit. Existing-data backfills are intentionally excluded.
CREATE TABLE sources(id TEXT PRIMARY KEY,record TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
--> statement-breakpoint
CREATE TABLE source_health(source_id TEXT PRIMARY KEY REFERENCES sources(id),checked_at TEXT,last_success_at TEXT,error TEXT,received INTEGER NOT NULL DEFAULT 0,checkpoint TEXT);
--> statement-breakpoint
CREATE TABLE observations(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),native_id TEXT NOT NULL,canonical_url TEXT NOT NULL,first_observed_at TEXT NOT NULL,latest_revision TEXT NOT NULL,deleted_at TEXT,UNIQUE(source_id,native_id));
--> statement-breakpoint
CREATE TABLE observation_revisions(report_id TEXT NOT NULL REFERENCES observations(id),revision TEXT NOT NULL,input TEXT NOT NULL,ingested_at TEXT NOT NULL,PRIMARY KEY(report_id,revision));
--> statement-breakpoint
CREATE TABLE analysis_jobs(id TEXT PRIMARY KEY,report_id TEXT NOT NULL,revision TEXT NOT NULL,contract_version TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',priority INTEGER NOT NULL DEFAULT 0,available_at TEXT NOT NULL,created_at TEXT NOT NULL,attempt_id TEXT,fence INTEGER NOT NULL DEFAULT 0,lease_until TEXT,worker_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,error_kind TEXT,error TEXT,completed_at TEXT,UNIQUE(report_id,revision,contract_version));
--> statement-breakpoint
CREATE INDEX job_scheduling ON analysis_jobs(state,available_at,priority,created_at);
--> statement-breakpoint
CREATE TABLE analysis_results(id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES analysis_jobs(id),report_id TEXT NOT NULL,revision TEXT NOT NULL,result TEXT NOT NULL,run TEXT NOT NULL,analyzed_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE origin_groups(id TEXT PRIMARY KEY,canonical_url TEXT NOT NULL UNIQUE,independence TEXT NOT NULL DEFAULT 'unknown');
--> statement-breakpoint
CREATE TABLE incidents(id TEXT PRIMARY KEY,version INTEGER NOT NULL,view TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
--> statement-breakpoint
CREATE TABLE incident_revisions(incident_id TEXT NOT NULL REFERENCES incidents(id),version INTEGER NOT NULL,view TEXT NOT NULL,known_at TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(incident_id,version));
--> statement-breakpoint
CREATE INDEX incident_replay ON incident_revisions(known_at);
--> statement-breakpoint
CREATE TABLE claims(id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL REFERENCES analysis_results(id),incident_id TEXT NOT NULL REFERENCES incidents(id),claim TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE evidence_links(incident_id TEXT NOT NULL REFERENCES incidents(id),report_id TEXT NOT NULL REFERENCES observations(id),revision TEXT NOT NULL,origin_id TEXT NOT NULL REFERENCES origin_groups(id),PRIMARY KEY(incident_id,report_id,revision));
--> statement-breakpoint
CREATE TABLE outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,entity_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
--> statement-breakpoint
CREATE TABLE workers(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL,state TEXT NOT NULL,details TEXT);
--> statement-breakpoint
CREATE TABLE watch_areas(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,geometry TEXT NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE alert_rules(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,version INTEGER NOT NULL,rule TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE alert_deliveries(id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,incident_version INTEGER NOT NULL,rule_id TEXT NOT NULL,rule_version INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(incident_id,incident_version,rule_id,rule_version));
--> statement-breakpoint
CREATE TABLE annotations(id TEXT PRIMARY KEY,incident_id TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS incidents_fts USING fts5(incident_id UNINDEXED, search_text, tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS incidents_search_insert AFTER INSERT ON incidents WHEN NEW.deleted_at IS NULL BEGIN INSERT INTO incidents_fts(incident_id,search_text) VALUES(NEW.id,NEW.view); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS incidents_search_update AFTER UPDATE ON incidents BEGIN DELETE FROM incidents_fts WHERE incident_id=OLD.id; INSERT INTO incidents_fts(incident_id,search_text) SELECT NEW.id,NEW.view WHERE NEW.deleted_at IS NULL; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS incidents_search_delete AFTER DELETE ON incidents BEGIN DELETE FROM incidents_fts WHERE incident_id=OLD.id; END;
--> statement-breakpoint
ALTER TABLE analysis_jobs ADD COLUMN invalid_attempts INTEGER NOT NULL DEFAULT 0;

--> statement-breakpoint
-- Read-budget schema from deploy/migrations/0004_read_budget.sql
CREATE INDEX IF NOT EXISTS jobs_state_created ON analysis_jobs(state,created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS jobs_lease_expiry ON analysis_jobs(lease_until) WHERE state='analyzing';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS jobs_pending_priority ON analysis_jobs(priority DESC,created_at,available_at) WHERE state IN ('pending','retrying');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS jobs_pending_fifo ON analysis_jobs(created_at,available_at) WHERE state IN ('pending','retrying');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS analysis_recent ON analysis_results(analyzed_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS incidents_recent ON incidents(updated_at DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS revisions_incident_time ON incident_revisions(incident_id,known_at DESC,version DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_report ON evidence_links(report_id,incident_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS outbox_created ON outbox(created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS observations_source_deleted ON observations(source_id,deleted_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS queue_counters(state TEXT PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0,oldest TEXT);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS queue_count_insert AFTER INSERT ON analysis_jobs BEGIN
 INSERT INTO queue_counters(state,count,oldest) VALUES(NEW.state,1,NEW.created_at) ON CONFLICT(state) DO UPDATE SET count=count+1,oldest=min(coalesce(oldest,NEW.created_at),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS queue_count_update AFTER UPDATE OF state,created_at ON analysis_jobs WHEN OLD.state<>NEW.state OR OLD.created_at<>NEW.created_at BEGIN
 UPDATE queue_counters SET count=max(0,count-1),oldest=(SELECT min(created_at) FROM analysis_jobs WHERE state=OLD.state) WHERE state=OLD.state;
 INSERT INTO queue_counters(state,count,oldest) VALUES(NEW.state,1,NEW.created_at) ON CONFLICT(state) DO UPDATE SET count=count+1,oldest=min(coalesce(oldest,NEW.created_at),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS queue_count_delete AFTER DELETE ON analysis_jobs BEGIN
 UPDATE queue_counters SET count=max(0,count-1),oldest=(SELECT min(created_at) FROM analysis_jobs WHERE state=OLD.state) WHERE state=OLD.state;
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS collector_config(id TEXT PRIMARY KEY,registry_hash TEXT NOT NULL);
