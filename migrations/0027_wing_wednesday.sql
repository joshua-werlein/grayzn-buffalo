-- Wing Wednesday: a recurring template plus one live section, using the existing
-- section tables. Additive only; no existing row is read or changed. Hidden until
-- the weekly transaction associates it with a Wednesday (section_service_date).
-- Options and sauces only. Prices come from a verified poster or staff entry.
INSERT INTO special_collections(id,kind,title,schedule) VALUES
  ('wing-wednesday-defaults','section','Wing Wednesday','Every Wednesday • 5–10 PM');
INSERT INTO special_collections(id,kind,title,schedule,section_source) VALUES
  ('wing-wednesday','section','Wing Wednesday','Every Wednesday • 5–10 PM','recurring');
INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled) VALUES
  ('ww-default:wings','wing-wednesday-defaults',-1,'custom','Wings','',0,1),
  ('ww-default:sauces','wing-wednesday-defaults',-1,'custom','Sauces','',1,1),
  ('ww-live:ww-default:wings','wing-wednesday',-1,'custom','Wings','',0,1),
  ('ww-live:ww-default:sauces','wing-wednesday',-1,'custom','Sauces','',1,1);
WITH items(position,wings,sauces) AS (VALUES
  (1,'Bone-In Wings','Sweet Chili'||char(10)||'BBQ'||char(10)||'Honey BBQ'||char(10)||'Jack BBQ'||char(10)||'Sweet & Sour'||char(10)||'Honey Garlic'||char(10)||'Ranch'||char(10)||'Chipotle Ranch'||char(10)||'Mango Habanero'||char(10)||'Boom Boom'||char(10)||'Sriracha Ranch'||char(10)||'Buffalo'||char(10)||'Teriyaki'||char(10)||'Honey Mustard'||char(10)||'Garlic Parmesan'||char(10)||'Signature'),
  (2,'Boneless Wings',''),(3,'',''),(4,'','')
), targets(group_id,kind) AS (VALUES
  ('ww-default:wings','wings'),('ww-default:sauces','sauces'),
  ('ww-live:ww-default:wings','wings'),('ww-live:ww-default:sauces','sauces')
)
INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value)
SELECT t.group_id,i.position,CASE t.kind WHEN 'wings' THEN i.wings ELSE i.sauces END,'','','manual',0,NULL
FROM targets t CROSS JOIN items i;
-- Daily posters already carry the Wing Night prices. Decisions about them live here,
-- apart from special_import_events: the daily reconciler relies on its own latest
-- 'review' event for each of those same imports.
CREATE TABLE wing_wednesday_decisions (
  import_id TEXT PRIMARY KEY REFERENCES special_imports(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('published','held','approved')),
  detail TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX wing_wednesday_decisions_week ON wing_wednesday_decisions(week_start,decided_at);
