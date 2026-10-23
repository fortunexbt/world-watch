DROP TRIGGER IF EXISTS incidents_search_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS incidents_search_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS incidents_search_delete;
--> statement-breakpoint
DROP TABLE IF EXISTS incidents_fts;
--> statement-breakpoint
CREATE VIRTUAL TABLE incidents_fts USING fts5(incident_id, search_text, tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
INSERT INTO incidents_fts(incident_id,search_text) SELECT id,view FROM incidents WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER incidents_search_insert AFTER INSERT ON incidents WHEN NEW.deleted_at IS NULL BEGIN INSERT INTO incidents_fts(incident_id,search_text) VALUES(NEW.id,NEW.view); END;
--> statement-breakpoint
CREATE TRIGGER incidents_search_update AFTER UPDATE ON incidents BEGIN DELETE FROM incidents_fts WHERE incidents_fts MATCH 'incident_id:"'||replace(OLD.id,'"','""')||'"'; INSERT INTO incidents_fts(incident_id,search_text) SELECT NEW.id,NEW.view WHERE NEW.deleted_at IS NULL; END;
--> statement-breakpoint
CREATE TRIGGER incidents_search_delete AFTER DELETE ON incidents BEGIN DELETE FROM incidents_fts WHERE incidents_fts MATCH 'incident_id:"'||replace(OLD.id,'"','""')||'"'; END;
