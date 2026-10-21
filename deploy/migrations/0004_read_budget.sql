CREATE INDEX IF NOT EXISTS jobs_state_created ON analysis_jobs(state,created_at);
CREATE INDEX IF NOT EXISTS jobs_lease_expiry ON analysis_jobs(lease_until) WHERE state='analyzing';
CREATE INDEX IF NOT EXISTS jobs_pending_priority ON analysis_jobs(priority DESC,created_at,available_at) WHERE state IN ('pending','retrying');
CREATE INDEX IF NOT EXISTS jobs_pending_fifo ON analysis_jobs(created_at,available_at) WHERE state IN ('pending','retrying');
CREATE INDEX IF NOT EXISTS analysis_recent ON analysis_results(analyzed_at DESC);
CREATE INDEX IF NOT EXISTS incidents_recent ON incidents(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS revisions_incident_time ON incident_revisions(incident_id,known_at DESC,version DESC);
CREATE INDEX IF NOT EXISTS evidence_report ON evidence_links(report_id,incident_id);
CREATE INDEX IF NOT EXISTS outbox_created ON outbox(created_at);
CREATE INDEX IF NOT EXISTS observations_source_deleted ON observations(source_id,deleted_at);
CREATE TABLE IF NOT EXISTS queue_counters(state TEXT PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0,oldest TEXT);
CREATE TRIGGER IF NOT EXISTS queue_count_insert AFTER INSERT ON analysis_jobs BEGIN
 INSERT INTO queue_counters(state,count,oldest) VALUES(NEW.state,1,NEW.created_at) ON CONFLICT(state) DO UPDATE SET count=count+1,oldest=min(coalesce(oldest,NEW.created_at),NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS queue_count_update AFTER UPDATE OF state,created_at ON analysis_jobs WHEN OLD.state<>NEW.state OR OLD.created_at<>NEW.created_at BEGIN
 UPDATE queue_counters SET count=max(0,count-1),oldest=(SELECT min(created_at) FROM analysis_jobs WHERE state=OLD.state) WHERE state=OLD.state;
 INSERT INTO queue_counters(state,count,oldest) VALUES(NEW.state,1,NEW.created_at) ON CONFLICT(state) DO UPDATE SET count=count+1,oldest=min(coalesce(oldest,NEW.created_at),NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS queue_count_delete AFTER DELETE ON analysis_jobs BEGIN
 UPDATE queue_counters SET count=max(0,count-1),oldest=(SELECT min(created_at) FROM analysis_jobs WHERE state=OLD.state) WHERE state=OLD.state;
END;
CREATE TABLE IF NOT EXISTS collector_config(id TEXT PRIMARY KEY,registry_hash TEXT NOT NULL);
