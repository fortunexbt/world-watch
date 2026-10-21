CREATE INDEX IF NOT EXISTS incidents_latitude ON incidents(json_extract(view,'$.location.lat')) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS incidents_radius ON incidents(json_extract(view,'$.location.radius_km')) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS incidents_window ON incidents(coalesce(max(coalesce(json_extract(view,'$.event_start'),json_extract(view,'$.published_at')),coalesce(json_extract(view,'$.expires_at'),coalesce(json_extract(view,'$.event_start'),json_extract(view,'$.published_at')))),'9')) WHERE deleted_at IS NULL;
