CREATE INDEX IF NOT EXISTS analyses_report_time ON analysis_results(report_id,analyzed_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS jobs_invalid_recent ON analysis_jobs(available_at DESC) WHERE error_kind='invalid';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS analysis_bundles(bundle_key TEXT PRIMARY KEY,leader_job_id TEXT NOT NULL REFERENCES analysis_jobs(id),created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bundle_members(job_id TEXT PRIMARY KEY REFERENCES analysis_jobs(id),bundle_key TEXT NOT NULL REFERENCES analysis_bundles(bundle_key));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bundle_members_key ON bundle_members(bundle_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS jobs_waiting_bundle ON analysis_jobs(created_at) WHERE state='bundled' AND completed_at IS NULL;
