DROP TRIGGER IF EXISTS incidents_search_insert;
DROP TRIGGER IF EXISTS incidents_search_update;
CREATE TRIGGER incidents_search_insert AFTER INSERT ON incidents WHEN NEW.deleted_at IS NULL BEGIN INSERT INTO incidents_fts(incident_id,search_text) VALUES(NEW.id,json_remove(NEW.view,'$.footprint')); END;
CREATE TRIGGER incidents_search_update AFTER UPDATE ON incidents BEGIN DELETE FROM incidents_fts WHERE incidents_fts MATCH 'incident_id:"'||replace(OLD.id,'"','""')||'"'; INSERT INTO incidents_fts(incident_id,search_text) SELECT NEW.id,json_remove(NEW.view,'$.footprint') WHERE NEW.deleted_at IS NULL; END;
