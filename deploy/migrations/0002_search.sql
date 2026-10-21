CREATE VIRTUAL TABLE IF NOT EXISTS incidents_fts USING fts5(incident_id UNINDEXED, search_text, tokenize='unicode61 remove_diacritics 2');
INSERT INTO incidents_fts(incident_id,search_text) SELECT id,view FROM incidents WHERE deleted_at IS NULL AND id NOT IN(SELECT incident_id FROM incidents_fts);
CREATE TRIGGER IF NOT EXISTS incidents_search_insert AFTER INSERT ON incidents WHEN NEW.deleted_at IS NULL BEGIN INSERT INTO incidents_fts(incident_id,search_text) VALUES(NEW.id,NEW.view); END;
CREATE TRIGGER IF NOT EXISTS incidents_search_update AFTER UPDATE ON incidents BEGIN DELETE FROM incidents_fts WHERE incident_id=OLD.id; INSERT INTO incidents_fts(incident_id,search_text) SELECT NEW.id,NEW.view WHERE NEW.deleted_at IS NULL; END;
CREATE TRIGGER IF NOT EXISTS incidents_search_delete AFTER DELETE ON incidents BEGIN DELETE FROM incidents_fts WHERE incident_id=OLD.id; END;
