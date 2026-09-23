-- Current bootstrap for a NEW database, not an upgrade script.
-- Do not replay historical ALTER/backfill migrations on top of this schema.
-- Categories are printed menu sections; Daily/Late Night are per-item views.
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,           -- Real menu section name
  sort INTEGER NOT NULL DEFAULT 0,
  subtitle TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  photo_key TEXT,
  photo_orientation TEXT NOT NULL DEFAULT 'portrait' CHECK (photo_orientation IN ('portrait', 'square', 'landscape')),
  late_night INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS welcome_photos (
  slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 4),
  photo_key TEXT,
  alt TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  orientation TEXT NOT NULL DEFAULT 'portrait' CHECK (orientation IN ('portrait', 'square', 'landscape'))
);
-- Retained legacy table, matching the historical schema through migration 0008.
-- Current pages use weekly_specials; no legacy specials are seeded here.
CREATE TABLE IF NOT EXISTS specials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  tag TEXT DEFAULT NULL,
  lunch_name TEXT NOT NULL DEFAULT '',
  lunch_description TEXT NOT NULL DEFAULT '',
  lunch_tag TEXT DEFAULT NULL,
  night_name TEXT NOT NULL DEFAULT '',
  night_description TEXT NOT NULL DEFAULT '',
  night_tag TEXT DEFAULT NULL,
  allday_name TEXT NOT NULL DEFAULT '',
  allday_description TEXT NOT NULL DEFAULT '',
  allday_tag TEXT DEFAULT NULL
);

-- Settings: single key/value store for site-wide toggles and copy.
-- Reusable for the delivery pause switch, happy-hour notice, holiday hours, etc.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Weekly specials are deliberately separate from the legacy fixed-weekday table.
-- Fresh databases need only the two current all-day fields. Migration 0011
-- retains/backfills allday_content on EXISTING databases; it is not replayed here.
CREATE TABLE IF NOT EXISTS weekly_specials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start_date TEXT NOT NULL,
  week_end_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (week_start_date GLOB '????-??-??'),
  CHECK (week_end_date GLOB '????-??-??'),
  CHECK (week_start_date <= week_end_date),
  UNIQUE (week_start_date, week_end_date)
);
CREATE INDEX IF NOT EXISTS weekly_specials_range_idx ON weekly_specials (week_start_date, week_end_date);
CREATE TABLE IF NOT EXISTS weekly_special_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekly_special_id INTEGER NOT NULL REFERENCES weekly_specials(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  lunch_content TEXT NOT NULL DEFAULT '',
  all_day_1_content TEXT NOT NULL DEFAULT '',
  all_day_2_content TEXT NOT NULL DEFAULT '',
  nightly_content TEXT NOT NULL DEFAULT '',
  UNIQUE (weekly_special_id, day_of_week)
);

-- Templates used only while initializing a brand-new, unsaved weekly form.
-- Nullable fields distinguish an intentionally unavailable default from a
-- saved weekly field, which always uses a non-null empty string when blank.
CREATE TABLE IF NOT EXISTS weekly_special_recurring_default_days (
  day_of_week INTEGER PRIMARY KEY CHECK (day_of_week BETWEEN 0 AND 6),
  lunch_content TEXT,
  all_day_1_content TEXT,
  all_day_2_content TEXT,
  nightly_content TEXT
);

-- Initial recurring templates from migration 0012, not live business data:
-- changing them never changes an existing weekly_special_days row.
INSERT INTO weekly_special_recurring_default_days (
  day_of_week,
  lunch_content,
  all_day_1_content,
  all_day_2_content,
  nightly_content
) VALUES
  (0, '16” 3-Topping Pizza & 12 Wings $30', 'Western Burger with Side Salad, Chili or Coleslaw $10.25', 'Chicken Salad Sandwich with cup of Chili or Coleslaw $7.25', NULL),
  (1, NULL, NULL, 'Chicken Salad Sandwich with cup of Chili or Coleslaw $7.25', '2 Burgers and 1 order of French Fries $14

1/2 Rack Ribs with Mac N Cheese & Coleslaw $18.75'),
  (2, NULL, NULL, 'Chicken Salad Sandwich with cup of Chili or Coleslaw $7.25', 'Mexican Night!  Ask to see our Menu!'),
  (3, NULL, NULL, 'Chicken Salad Sandwich with cup of Chili or Coleslaw $7.25', 'Wing Night!

$.89 Boneless Wings
$.99 Bone In Wings
Add Fries'),
  (4, NULL, NULL, 'Chicken Salad Sandwich with cup of Chili or Coleslaw $7.25', '12” 3-Topping Pizza $13.50
16” 3-Topping Pizza $16'),
  (5, NULL, NULL, 'Chicken Salad Sandwich with cup of Chili or Coleslaw $7.25', '1 or 2 Piece Fish with 3 Jumbo Shrimp, French Fries & Choice of Side Salad or Coleslaw $12.99/$13.99

Chicken Stir Fry $12.99
Steak Stir Fry $13.99'),
  (6, 'Philly & French Fries $11', 'Bacon Cheeseburger with Side Salad, Chili or Coleslaw $10.25', 'Chicken Salad Sandwich with cup of Chili or Coleslaw $7.25', NULL)
ON CONFLICT(day_of_week) DO NOTHING;
 
-- Three independently managed announcements plus the delivery-status toggle.
INSERT INTO settings (key, value) VALUES
 ('announcement_1', ''),
 ('announcement_2', ''),
 ('announcement_3', ''),
 ('delivery_display', 'available')
ON CONFLICT(key) DO NOTHING;
 
-- Menu content is restored separately from recovery/menu-canonical.sql into empty menu tables.
CREATE TABLE IF NOT EXISTS facebook_outbound_clicks_daily (
  date TEXT PRIMARY KEY CHECK (date GLOB '????-??-??'),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
);

-- Normalized specials: same parity-gated cutover as upgrades 0015/0016.
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

-- Title/schedule already present in src/pages/specials.astro. No menu invented.
INSERT INTO special_collections(id,kind,title,schedule)
VALUES ('mexican-night','section','Mexican Night','Tuesdays · 5 – 10 PM');

-- Facebook import tracking (migration 0017). Apply with d1 execute only.
CREATE TABLE IF NOT EXISTS special_imports (
  id TEXT PRIMARY KEY,
  fb_post_id TEXT NOT NULL,
  fb_created_time TEXT NOT NULL,
  fb_updated_time TEXT,
  caption TEXT NOT NULL DEFAULT '',
  permalink_url TEXT NOT NULL DEFAULT '',
  caption_hash TEXT NOT NULL DEFAULT '',
  image_source_version TEXT NOT NULL DEFAULT '',
  image_r2_key TEXT,
  image_hash TEXT,
  parser_version INTEGER NOT NULL DEFAULT 1,
  model_id TEXT NOT NULL DEFAULT '',
  target_kind TEXT CHECK(target_kind IN ('week','section','ambiguous','ignored')),
  target_day INTEGER CHECK(target_day BETWEEN -1 AND 6),
  target_service TEXT,
  target_collection_id TEXT,
  classification_reason TEXT NOT NULL DEFAULT '',
  extracted_json TEXT,
  candidate_json TEXT,
  validation_result TEXT CHECK(validation_result IN ('ok','rejected')),
  validation_reason TEXT NOT NULL DEFAULT '',
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(processing_status IN ('pending','processing','staged','failed','skipped')),
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(review_status IN ('pending','accepted','edited','kept','dismissed')),
  review_reason TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS special_imports_review ON special_imports(review_status, processing_status, fetched_at);
CREATE INDEX IF NOT EXISTS special_imports_post ON special_imports(fb_post_id, fb_created_time);
CREATE TABLE IF NOT EXISTS special_import_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id TEXT NOT NULL REFERENCES special_imports(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK(event_type IN ('fetch','classify','extract','validate','stage','review','retry','error')),
  detail TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS special_import_events_import ON special_import_events(import_id, occurred_at);
