CREATE INDEX IF NOT EXISTS observation_ingested_time ON observation_revisions(ingested_at,report_id);
--> statement-breakpoint
CREATE TABLE brief_windows(id TEXT PRIMARY KEY,window_start TEXT NOT NULL,window_end TEXT NOT NULL UNIQUE,state TEXT NOT NULL,input TEXT NOT NULL,provenance TEXT NOT NULL,result TEXT,run TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,token TEXT,lease_until TEXT,available_at TEXT NOT NULL,worker_id TEXT,error_kind TEXT,error TEXT);
--> statement-breakpoint
CREATE INDEX brief_latest ON brief_windows(state,window_end DESC);
--> statement-breakpoint
CREATE INDEX brief_retention ON brief_windows(window_end);
--> statement-breakpoint
CREATE TABLE brief_evidence(window_id TEXT NOT NULL REFERENCES brief_windows(id) ON DELETE CASCADE,incident_id TEXT NOT NULL,incident_version INTEGER NOT NULL,report_id TEXT NOT NULL,revision TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(window_id,incident_id,report_id,revision));
--> statement-breakpoint
CREATE INDEX brief_evidence_report ON brief_evidence(report_id,window_id);
--> statement-breakpoint
CREATE INDEX brief_evidence_source ON brief_evidence(source_id,window_id);
--> statement-breakpoint
CREATE INDEX brief_evidence_incident ON brief_evidence(incident_id,window_id);
--> statement-breakpoint
CREATE TRIGGER brief_observation_purge AFTER UPDATE OF deleted_at ON observations WHEN NEW.deleted_at IS NOT NULL BEGIN DELETE FROM brief_windows WHERE id IN(SELECT window_id FROM brief_evidence WHERE report_id=NEW.id); END;
--> statement-breakpoint
CREATE TRIGGER brief_rights_purge AFTER UPDATE OF record ON sources WHEN coalesce(json_extract(NEW.record,'$.rights.access'),0)=0 OR coalesce(json_extract(NEW.record,'$.rights.storage'),0)=0 OR coalesce(json_extract(NEW.record,'$.rights.display'),0)=0 OR coalesce(json_extract(NEW.record,'$.rights.ai'),0)=0 BEGIN DELETE FROM brief_windows WHERE id IN(SELECT window_id FROM brief_evidence WHERE source_id=NEW.id); END;
--> statement-breakpoint
CREATE TRIGGER brief_incident_purge AFTER UPDATE OF deleted_at ON incidents WHEN NEW.deleted_at IS NOT NULL BEGIN DELETE FROM brief_windows WHERE id IN(SELECT window_id FROM brief_evidence WHERE incident_id=NEW.id); END;
--> statement-breakpoint
CREATE TRIGGER brief_evidence_cleanup AFTER DELETE ON brief_windows BEGIN DELETE FROM brief_evidence WHERE window_id=OLD.id; END;
--> statement-breakpoint
