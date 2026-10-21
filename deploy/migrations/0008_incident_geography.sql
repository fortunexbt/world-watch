CREATE INDEX IF NOT EXISTS incidents_latitude ON incidents(json_extract(view,'$.location.lat')) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS incidents_radius ON incidents(json_extract(view,'$.location.radius_km')) WHERE deleted_at IS NULL;
