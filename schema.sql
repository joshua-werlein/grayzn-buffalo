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
  photo_key TEXT
);
-- Specials: one per day-of-week (0=Sun..6=Sat); tag e.g. 'Mexican Night'
CREATE TABLE IF NOT EXISTS specials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  tag TEXT DEFAULT NULL
);

-- Settings: single key/value store for site-wide toggles and copy.
-- Reusable for the delivery pause switch, happy-hour notice, holiday hours, etc.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Seed the announcement row empty so the banner stays hidden until staff set it.
INSERT INTO settings (key, value) VALUES ('announcement', '')
  ON CONFLICT(key) DO NOTHING;


INSERT INTO categories (name, sort) VALUES ('Daily', 0), ('Late Night', 1);
INSERT INTO items (category_id, name, description, sort) VALUES
 (1, 'Grayz''n Burger', 'Half-pound burger with your choice of side.', 0),
 (1, 'Grilled Chicken Salad', 'Grilled chicken over fresh greens.', 1),
 (1, 'Broasted Chicken', 'Golden broasted chicken.', 2),
 (1, 'Soft Pretzel & Cheese', 'Warm pretzel with cheese sauce.', 3),
 (2, 'Pizza', 'Hot from the oven after the grill closes.', 0),
 (2, 'Pizza Fries', 'The late-night favorite.', 1),
 (2, 'Appetizers', 'Ask what''s in the fryer tonight.', 2);
INSERT INTO specials (day_of_week, name, description, tag) VALUES
 (0, 'Broasted Chicken Dinner', 'Golden broasted chicken with all the fixings.', NULL),
 (1, 'Burger & Basket Night', 'Grayz''n Burger with a basket of waffle fries.', NULL),
 (2, 'Mexican Night', 'Tacos, quesadillas, and wet burritos.', 'Mexican Night'),
 (3, 'Grilled Chicken Salad', 'Plus the Grayz''n Burger with a side.', NULL),
 (4, 'Soup & Sandwich', 'Cup of the day''s soup with a grilled sandwich.', NULL),
 (5, 'Friday Fish', 'It''s Wisconsin — you know what night it is.', NULL),
 (6, 'Grill Master''s Pick', 'Whatever the kitchen''s fired up about.', NULL);
