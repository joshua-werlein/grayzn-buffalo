-- Reseed the menu to the nine real printed categories + Late Night flag.
-- Staging seed data — safe to re-run. This WIPES existing categories/items
-- (any test photos already uploaded become orphaned R2 objects — harmless on
-- staging; ignore them or clean the bucket later).
--
-- Run AFTER 0003_late_night.sql:
--   npx wrangler d1 execute grayzn-db --remote --file=./migrations/seed_menu.sql
--
-- late_night = 1 on Appetizers + Pizzas (the after-grill menu: pizza,
-- pizza fries, appetizers). Everything else = 0.
--
-- ~5 items per category are INTENTIONALLY LEFT OUT so staff add them as a
-- test in /admin/menu. Left out:
--   Appetizers: Cheesy Jalapeno Potato Bites, Cheese Bombs, Breadsticks,
--               Choice of any 3 Appetizers, Egg Rolls
--   Baskets:    Fish Basket, Jumbo Shrimp Basket
--   Sandwiches: BLT, Reuben, Club, Gyro Sandwich, Garlic Turkey Bacon Sub
--   Burgers:    Western, German, Hangover, Jalapeno, Southwest
--   Wraps:      Turkey Bacon, Hawaiian BBQ Chicken,
--               Chipotle Chicken Bacon Ranch, Buffalo Chicken
--   Pizzas:     Buffalo Chicken, Chicken Bacon Ranch, Reuben,
--               Philly Cheesesteak, Gyro
--   Salads:     Grilled/Crispy Chicken, Chicken Chipotle, Gyro,
--               Chicken Cranberry, Hawaiian Chicken
--   Loaded Tot Baskets: Chicken Bacon Ranch Tots
--   On The Lighter Side: 2 Grilled Cheese & Fries, 5 Mini Corn Dogs & Fries,
--               Lite Salad

DELETE FROM items;
DELETE FROM categories;
DELETE FROM sqlite_sequence WHERE name IN ('items', 'categories');

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
-- category_id 1..9 follows the order above.

-- ── Appetizers (cat 1, late_night 1) ────────────────────────────────────
INSERT INTO items (category_id, name, description, late_night, sort) VALUES
 (1, 'French Fries', '', 1, 0),
 (1, 'Tator Tots', '', 1, 1),
 (1, 'Waffle Fries', '', 1, 2),
 (1, 'Beer Fries', '', 1, 3),
 (1, 'Sweet Potato Fries', '', 1, 4),
 (1, 'Onion Rings', '', 1, 5),
 (1, 'Funnel Cake Fries', '', 1, 6),
 (1, 'Mozzarella Sticks', '', 1, 7),
 (1, '6 Drummies', '', 1, 8),
 (1, '8 Mini Corn Dogs', '', 1, 9),
 (1, 'Big Pretzel', '', 1, 10),
 (1, 'Jalapeno Poppers', '', 1, 11),
 (1, 'Cheese Curds', 'White, yellow or jalapeno.', 1, 12),
 (1, 'Battered Mushrooms', '', 1, 13),
 (1, 'Mini Tacos', '', 1, 14),
 (1, 'Broccoli Bites', '', 1, 15),
 (1, '4 Chicken Strips', '', 1, 16),
 (1, 'Mac & Cheese Bites', '', 1, 17),
 (1, 'Deep Fried Pickles', '', 1, 18);

-- ── Baskets (cat 2) — served with French fries & toast ──────────────────
INSERT INTO items (category_id, name, description, late_night, sort) VALUES
 (2, 'Drummie Basket', 'Served with French fries & toast.', 0, 0),
 (2, 'Shrimp Basket', 'Served with French fries & toast.', 0, 1),
 (2, 'Chicken Strip Basket', 'Served with French fries & toast.', 0, 2);

-- ── Sandwiches (cat 3) — served with chips & pickle ─────────────────────
INSERT INTO items (category_id, name, description, late_night, sort) VALUES
 (3, 'Chicken Sandwich', 'Lettuce and mayo.', 0, 0),
 (3, 'Chicken Bacon Swiss', 'Bacon and Swiss cheese.', 0, 1),
 (3, 'Buffalo Chicken', 'Lettuce, tomato, bleu cheese, buffalo sauce.', 0, 2),
 (3, 'Hawaiian Chicken', 'Ham, grilled pineapple, Swiss cheese.', 0, 3),
 (3, 'Bacon Chicken Ranch', 'Bacon, pepper jack cheese, ranch dressing.', 0, 4),
 (3, 'Honey Mustard Chicken', 'Lettuce, Swiss cheese, honey mustard dressing.', 0, 5),
 (3, 'Chicken Cordon Bleu', 'Ham and Swiss cheese.', 0, 6),
 (3, 'Chicken Chipotle', 'Bacon, lettuce, cheddar cheese, onion, tomato, chipotle ranch.', 0, 7),
 (3, 'Grayz''n Chicken', 'Ham, cheddar and Swiss cheese, BBQ sauce.', 0, 8),
 (3, 'Fish Sandwich', 'Lettuce, cheddar cheese, tartar sauce.', 0, 9),
 (3, 'Philly Cheese', 'Onion, green peppers, mushrooms, choice of beef or chicken.', 0, 10);

-- ── Burgers (cat 4) — served with chips & pickle ────────────────────────
INSERT INTO items (category_id, name, description, late_night, sort) VALUES
 (4, 'Hamburger', '', 0, 0),
 (4, 'Cheeseburger', '', 0, 1),
 (4, 'Double Cheeseburger', '', 0, 2),
 (4, 'Mushroom Swiss', '', 0, 3),
 (4, 'Bacon Cheeseburger', '', 0, 4),
 (4, 'California Burger', '', 0, 5),
 (4, 'Patty Melt', '', 0, 6),
 (4, 'Pizza Burger', 'Pepperoni, mozzarella cheese, pizza sauce.', 0, 7),
 (4, 'Stampede Burger', 'Bacon, mushrooms, pepper jack cheese, horseradish sauce.', 0, 8),
 (4, 'Grayz''n Burger', 'Ham, cheddar and Swiss cheese, BBQ sauce.', 0, 9),
 (4, 'The G Mac', 'Lettuce, onion, pickles, thousand island dressing.', 0, 10),
 (4, 'Dovi Burger', 'Cheddar cheese, BBQ sauce.', 0, 11),
 (4, 'Bleu Cheese Burger', 'Bacon, fried onions, pepper jack cheese, bleu cheese dressing.', 0, 12),
 (4, 'Olive Burger', 'Green olives and Swiss cheese.', 0, 13);

-- ── Wraps (cat 5) — served with chips & pickle ──────────────────────────
INSERT INTO items (category_id, name, description, late_night, sort) VALUES
 (5, 'Chicken Bacon Ranch', 'Bacon, lettuce, cheddar cheese, ranch dressing.', 0, 0),
 (5, 'Chicken Caesar', 'Lettuce, onion, tomato, parmesan cheese, Caesar dressing.', 0, 1),
 (5, 'Philly Cheese', 'Onion, green peppers, mushrooms, choice of beef or chicken.', 0, 2),
 (5, 'BLT', 'Bacon, lettuce, tomato, mayo.', 0, 3);

-- ── Pizzas (cat 6, late_night 1) — thin, regular, or deep-dish crust ─────
INSERT INTO items (category_id, name, description, late_night, sort) VALUES
 (6, 'Cheese', '', 1, 0),
 (6, 'Sausage & Pepperoni', '', 1, 1),
 (6, 'Hawaiian', 'Canadian bacon, pineapple.', 1, 2),
 (6, 'Meat', 'Sausage, pepperoni, Canadian bacon, beef, bacon.', 1, 3),
 (6, 'Deluxe', 'Sausage, pepperoni, mushroom, onion, green pepper.', 1, 4),
 (6, 'Veggie', 'Mushroom, onion, green pepper, tomato, green & black olives.', 1, 5),
 (6, 'BBQ Chicken', 'BBQ sauce, bacon, chicken, onion.', 1, 6),
 (6, 'Taco', 'Taco meat, onion, mozzarella & cheddar, tomato, black olives, lettuce.', 1, 7),
 (6, 'Chicken Alfredo', 'Alfredo sauce, chicken, onion.', 1, 8),
 (6, 'Bacon Cheeseburger', 'Beef, bacon, mozzarella & cheddar cheese, pickles.', 1, 9),
 (6, 'Supreme', 'Beef, sausage, bacon, onions, green peppers, mushrooms, green & black olives.', 1, 10),
 (6, 'Pizza Fries', '', 1, 11);

-- ── Salads (cat 7) ──────────────────────────────────────────────────────
INSERT INTO items (category_id, name, description, late_night, sort) VALUES
 (7, 'Side Salad', 'Tomato, onion, cucumber, green pepper, cheddar cheese, hard-boiled egg.', 0, 0),
 (7, 'Chef Salad', 'Ham, turkey, cheddar cheese, hard-boiled egg, croutons.', 0, 1),
 (7, 'Taco Salad', 'Taco meat, tomato, onion, black olives, cheddar cheese.', 0, 2),
 (7, 'Caesar Salad', 'Chicken, tomato, onion, cucumber, parmesan cheese, hard-boiled egg, croutons, Caesar dressing.', 0, 3);

-- ── Loaded Tot Baskets (cat 8) ──────────────────────────────────────────
INSERT INTO items (category_id, name, description, late_night, sort) VALUES
 (8, 'Philly Tots', 'Tots, philly meat, onion, mushrooms, green peppers, nacho cheese.', 0, 0),
 (8, 'Taco Tots', 'Tots, taco meat, onion, tomato, black olives, nacho cheese.', 0, 1);

-- ── On The Lighter Side (cat 9) ─────────────────────────────────────────
INSERT INTO items (category_id, name, description, late_night, sort) VALUES
 (9, '1 Grilled Cheese & French Fries', '', 0, 0),
 (9, '2 Chicken Strips & French Fries', '', 0, 1),
 (9, 'Chicken Quesadilla', '', 0, 2);