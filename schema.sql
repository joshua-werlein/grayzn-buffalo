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
  late_night INTEGER NOT NULL DEFAULT 0   -- 1 = available after the grill closes
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