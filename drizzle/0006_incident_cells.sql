CREATE INDEX IF NOT EXISTS incidents_cell ON incidents(CAST((json_extract(view,'$.location.lat')+90)/10 AS INTEGER)*37+CAST((json_extract(view,'$.location.lon')+180)/10 AS INTEGER),CASE WHEN json_extract(view,'$.current_listing') THEN '9' ELSE coalesce(max(coalesce(json_extract(view,'$.event_start'),json_extract(view,'$.published_at')),coalesce(json_extract(view,'$.expires_at'),coalesce(json_extract(view,'$.event_start'),json_extract(view,'$.published_at')))),'9') END) WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS incidents_latitude;
