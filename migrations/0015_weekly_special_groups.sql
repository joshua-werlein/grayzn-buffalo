-- Apply with d1 execute only, during the documented application cutover.
-- Legacy tables and all their values remain intact. Normalized collections are
-- the only writable specials content after the parity gate below succeeds.
CREATE TABLE special_collections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('week','defaults','section')),
  weekly_special_id INTEGER UNIQUE REFERENCES weekly_specials(id),
  title TEXT NOT NULL DEFAULT '',
  schedule TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  mutation_token TEXT NOT NULL DEFAULT '',
  CHECK((kind = 'week') = (weekly_special_id IS NOT NULL))
);
CREATE UNIQUE INDEX special_defaults_unique ON special_collections(kind) WHERE kind = 'defaults';
CREATE TABLE special_groups (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES special_collections(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN -1 AND 6),
  service TEXT NOT NULL CHECK(service IN ('lunch','all-day','nightly','custom')),
  label TEXT NOT NULL,
  service_time TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
CREATE INDEX special_groups_collection ON special_groups(collection_id,day_of_week,sort);
CREATE TABLE special_slots (
  group_id TEXT NOT NULL REFERENCES special_groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 4),
  content TEXT,
  price TEXT NOT NULL DEFAULT '',
  section_link TEXT NOT NULL DEFAULT '' CHECK(section_link IN ('','mexican-night')),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('legacy','manual','automation')),
  manual_locked INTEGER NOT NULL DEFAULT 1 CHECK(manual_locked IN (0,1)),
  last_auto_value TEXT,
  PRIMARY KEY(group_id,position)
);

INSERT INTO special_collections(id,kind,weekly_special_id)
SELECT 'week:' || id,'week',id FROM weekly_specials;
INSERT INTO special_collections(id,kind,title) VALUES ('defaults','defaults','Recurring Defaults');

INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled)
SELECT 'day:' || d.id || ':' || s.service, 'week:' || d.weekly_special_id,d.day_of_week,s.service,
 CASE WHEN s.service='lunch' AND d.day_of_week=6 THEN 'Saturday Special'
      WHEN s.service='lunch' AND d.day_of_week=0 THEN 'Sunday Special' ELSE s.label END,
 CASE WHEN s.service='lunch' AND d.day_of_week IN (0,6) THEN '' ELSE s.time END,s.sort,
 CASE WHEN s.service='nightly' AND d.day_of_week IN (0,6) THEN 0 ELSE 1 END
FROM weekly_special_days d CROSS JOIN (
 SELECT 'lunch' service,'Lunch' label,'11 AM–1:30 PM' time,0 sort
 UNION ALL SELECT 'all-day','All Day Specials','',1
 UNION ALL SELECT 'nightly','Nightly','5–10 PM',2
) s;
INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled)
SELECT 'default:' || d.day_of_week || ':' || s.service,'defaults',d.day_of_week,s.service,
 CASE WHEN s.service='lunch' AND d.day_of_week=6 THEN 'Saturday Special'
      WHEN s.service='lunch' AND d.day_of_week=0 THEN 'Sunday Special' ELSE s.label END,
 CASE WHEN s.service='lunch' AND d.day_of_week IN (0,6) THEN '' ELSE s.time END,s.sort,
 CASE WHEN s.service='nightly' AND d.day_of_week IN (0,6) THEN 0 ELSE 1 END
FROM weekly_special_recurring_default_days d CROSS JOIN (
 SELECT 'lunch' service,'Lunch' label,'11 AM–1:30 PM' time,0 sort
 UNION ALL SELECT 'all-day','All Day Specials','',1
 UNION ALL SELECT 'nightly','Nightly','5–10 PM',2
) s;
INSERT INTO special_slots(group_id,position,content,origin)
SELECT g.id,p.position,
 CASE WHEN g.service='lunch' AND p.position=1 THEN d.lunch_content
      WHEN g.service='nightly' AND p.position=1 THEN d.nightly_content
      WHEN g.service='all-day' AND p.position=1 THEN d.all_day_1_content
      WHEN g.service='all-day' AND p.position=2 THEN d.all_day_2_content ELSE '' END,'legacy'
FROM weekly_special_days d JOIN special_groups g ON g.collection_id='week:' || d.weekly_special_id AND g.day_of_week=d.day_of_week
CROSS JOIN (SELECT 1 position UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) p;
INSERT INTO special_slots(group_id,position,content,origin)
SELECT g.id,p.position,
 CASE WHEN g.service='lunch' AND p.position=1 THEN d.lunch_content
      WHEN g.service='nightly' AND p.position=1 THEN d.nightly_content
      WHEN g.service='all-day' AND p.position=1 THEN d.all_day_1_content
      WHEN g.service='all-day' AND p.position=2 THEN d.all_day_2_content ELSE NULL END,'legacy'
FROM weekly_special_recurring_default_days d JOIN special_groups g ON g.collection_id='defaults' AND g.day_of_week=d.day_of_week
CROSS JOIN (SELECT 1 position UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) p;

-- Durable one-row parity certificate. IS comparisons preserve NULL versus ''.
CREATE TABLE special_migration_checks (version INTEGER PRIMARY KEY, mismatches INTEGER NOT NULL CHECK(mismatches=0));
INSERT INTO special_migration_checks VALUES (15,
 (SELECT abs(count(*)-(SELECT count(*) FROM weekly_specials)) FROM special_collections WHERE kind='week') +
 (SELECT abs(count(*)-3*(SELECT count(*) FROM weekly_special_days)) FROM special_groups WHERE collection_id<>'defaults') +
 (SELECT count(*) FROM weekly_special_days d WHERE
  NOT EXISTS (SELECT 1 FROM special_slots WHERE group_id='day:'||d.id||':lunch' AND position=1 AND content IS d.lunch_content) OR
  NOT EXISTS (SELECT 1 FROM special_slots WHERE group_id='day:'||d.id||':nightly' AND position=1 AND content IS d.nightly_content) OR
  NOT EXISTS (SELECT 1 FROM special_slots WHERE group_id='day:'||d.id||':all-day' AND position=1 AND content IS d.all_day_1_content) OR
  NOT EXISTS (SELECT 1 FROM special_slots WHERE group_id='day:'||d.id||':all-day' AND position=2 AND content IS d.all_day_2_content)) +
 (SELECT count(*) FROM weekly_special_recurring_default_days d WHERE
  NOT EXISTS (SELECT 1 FROM special_slots WHERE group_id='default:'||d.day_of_week||':lunch' AND position=1 AND content IS d.lunch_content) OR
  NOT EXISTS (SELECT 1 FROM special_slots WHERE group_id='default:'||d.day_of_week||':nightly' AND position=1 AND content IS d.nightly_content) OR
  NOT EXISTS (SELECT 1 FROM special_slots WHERE group_id='default:'||d.day_of_week||':all-day' AND position=1 AND content IS d.all_day_1_content) OR
  NOT EXISTS (SELECT 1 FROM special_slots WHERE group_id='default:'||d.day_of_week||':all-day' AND position=2 AND content IS d.all_day_2_content))
);
CREATE TRIGGER legacy_special_days_insert BEFORE INSERT ON weekly_special_days BEGIN SELECT RAISE(ABORT,'Specials migrated: use normalized editor'); END;
CREATE TRIGGER legacy_special_days_update BEFORE UPDATE ON weekly_special_days BEGIN SELECT RAISE(ABORT,'Specials migrated: use normalized editor'); END;
CREATE TRIGGER legacy_special_days_delete BEFORE DELETE ON weekly_special_days BEGIN SELECT RAISE(ABORT,'Legacy specials are preserved'); END;
CREATE TRIGGER legacy_special_defaults_insert BEFORE INSERT ON weekly_special_recurring_default_days BEGIN SELECT RAISE(ABORT,'Specials migrated: use normalized editor'); END;
CREATE TRIGGER legacy_special_defaults_update BEFORE UPDATE ON weekly_special_recurring_default_days BEGIN SELECT RAISE(ABORT,'Specials migrated: use normalized editor'); END;
CREATE TRIGGER legacy_special_defaults_delete BEFORE DELETE ON weekly_special_recurring_default_days BEGIN SELECT RAISE(ABORT,'Legacy defaults are preserved'); END;
