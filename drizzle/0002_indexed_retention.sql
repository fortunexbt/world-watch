ALTER TABLE observations ADD COLUMN expires_at TEXT;
--> statement-breakpoint
UPDATE observations SET expires_at=(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',r.ingested_at,'+'||max(0,coalesce(json_extract(s.record,'$.rights.retention_days'),30))||' days') FROM observation_revisions r JOIN sources s ON s.id=observations.source_id WHERE r.report_id=observations.id AND r.revision=observations.latest_revision) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS observations_expiry ON observations(expires_at) WHERE deleted_at IS NULL;
