-- Grayz'n Buffalo menu system. One system, admin-managed categories.
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,           -- 'Daily', 'Late Night'
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  photo_key TEXT,
  photo_orientation TEXT NOT NULL DEFAULT 'portrait',
  late_night INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS welcome_photos (
  slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 4),
  photo_key TEXT,
  alt TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  orientation TEXT NOT NULL DEFAULT 'portrait'
);
-- Specials: one per day-of-week (0=Sun..6=Sat); tag e.g. 'Mexican Night'
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
  night_tag TEXT DEFAULT NULL
);

-- Grayz'n Buffalo menu system. One system, admin-managed categories.
-- categories = the real printed menu sections. "Daily" / "Late Night" are
-- UI tabs on /menu, NOT rows here. Late Night is a per-item flag (see items).
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,           -- 'Appetizers', 'Burgers', 'Pizzas', ...
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  photo_key TEXT,
  photo_orientation TEXT NOT NULL DEFAULT 'portrait',
  late_night INTEGER NOT NULL DEFAULT 0   -- 1 = available after the grill closes
);
-- Specials: one per day-of-week (0=Sun..6=Sat); tag e.g. 'Mexican Night'
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
  night_tag TEXT DEFAULT NULL
);
 
-- Settings: single key/value store for site-wide toggles and copy.
-- Reusable for the delivery pause switch, happy-hour notice, holiday hours, etc.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Weekly specials are deliberately separate from the legacy fixed-weekday table.
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
  allday_content TEXT NOT NULL DEFAULT '',
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

-- Seed from the verified latest calendar-week data. These are templates only:
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
 
-- ── Category seed (nine real printed sections) ──────────────────────────
INSERT INTO categories (name, sort) VALUES
 ('Appetizers', 0),
 ('Baskets', 1),
 ('Sandwiches', 2),
 ('Burgers', 3),
 ('Wraps', 4),
 ('Pizzas', 5),
 ('Salads', 6),
 ('Loaded Tot Baskets', 7),
 ('On The Lighter Side', 8);
 
-- ── Item seed (a handful per category; ~5 per category left for staff to
--    add through /admin as a test — see migrations/seed_menu.sql for the
--    full list and the intentional gaps). late_night = 1 on Appetizers +
--    Pizzas (pizza, pizza fries, appetizers = the after-grill menu). ──────
INSERT INTO items (category_id, name, description, late_night, sort) VALUES
 (1, 'French Fries', '', 1, 0),
 (1, 'Cheese Curds', 'White, yellow or jalapeno.', 1, 1),
 (1, 'Big Pretzel', '', 1, 2),
 (1, 'Mozzarella Sticks', '', 1, 3),
 (2, 'Chicken Strip Basket', 'Served with French fries & toast.', 0, 0),
 (3, 'Grayz''n Chicken', 'Ham, cheddar and Swiss cheese, BBQ sauce.', 0, 0),
 (4, 'Grayz''n Burger', 'Ham, cheddar and Swiss cheese, BBQ sauce.', 0, 0),
 (4, 'Bacon Cheeseburger', '', 0, 1),
 (5, 'Chicken Bacon Ranch', 'Bacon, lettuce, cheddar cheese, ranch dressing.', 0, 0),
 (6, 'Cheese', '', 1, 0),
 (6, 'Pizza Fries', '', 1, 1),
 (7, 'Side Salad', 'Tomato, onion, cucumber, green pepper, cheddar cheese, hard-boiled egg.', 0, 0),
 (8, 'Philly Tots', 'Tots, philly meat, onion, mushrooms, green peppers, nacho cheese.', 0, 0),
 (9, 'Chicken Quesadilla', '', 0, 0);
 
INSERT INTO specials (day_of_week, name, description, tag) VALUES
 (0, 'Broasted Chicken Dinner', 'Golden broasted chicken with all the fixings.', NULL),
 (1, 'Burger & Basket Night', 'Grayz''n Burger with a basket of waffle fries.', NULL),
 (2, 'Mexican Night', 'Tacos, quesadillas, and wet burritos.', 'Mexican Night'),
 (3, 'Grilled Chicken Salad', 'Plus the Grayz''n Burger with a side.', NULL),
 (4, 'Soup & Sandwich', 'Cup of the day''s soup with a grilled sandwich.', NULL),
 (5, 'Friday Fish', 'It''s Wisconsin — you know what night it is.', NULL),
 (6, 'Grill Master''s Pick', 'Whatever the kitchen''s fired up about.', NULL);

-- Fresh installs begin with the existing daily lineup as their Nightly specials.
UPDATE specials
SET night_name = name,
    night_description = description,
    night_tag = tag
WHERE night_name = '';
