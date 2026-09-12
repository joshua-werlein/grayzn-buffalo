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
