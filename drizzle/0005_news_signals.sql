CREATE TABLE IF NOT EXISTS news_files(source_id TEXT NOT NULL,file_at TEXT NOT NULL,ingested_at TEXT NOT NULL,articles INTEGER NOT NULL,PRIMARY KEY(source_id,file_at));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS news_files_time ON news_files(file_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS news_places(id TEXT PRIMARY KEY,place TEXT NOT NULL,hours TEXT NOT NULL,articles TEXT NOT NULL,score REAL NOT NULL,updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS news_places_score ON news_places(score DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS news_places_updated ON news_places(updated_at);
