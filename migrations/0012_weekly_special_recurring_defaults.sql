-- Templates used only while initializing a brand-new, unsaved weekly form.
-- Nullable fields distinguish an intentionally unavailable default from a
-- saved weekly field, which always uses a non-null empty string when blank.
CREATE TABLE weekly_special_recurring_default_days (
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
