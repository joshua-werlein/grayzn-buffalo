-- Targeted, repeatable correction. Apply after 0013_category_details.sql.
-- Existing Late Night flags, descriptions, photos and other categories are untouched.
UPDATE items SET active = 0 WHERE id = 13 AND category_id = 1 AND name = 'Cheese Curds' AND late_night = 0 AND photo_key IS NULL;
INSERT INTO categories (name, sort, subtitle, note)
SELECT 'Mexican Night', COALESCE(MAX(sort), -1) + 1, 'Tuesdays · 5–10 PM',
 'Chicken substitution available · Nacho cheese, queso and shredded-cheese substitutions available'
FROM categories WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = 'Mexican Night')
HAVING COUNT(*) > 0;

INSERT INTO items (category_id,name,description,sort,active,late_night) SELECT id,'2 Soft Shell','Meat, shredded cheese, lettuce, onion, tomato, and black olives.',0,1,0 FROM categories c WHERE c.name='Mexican Night' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.category_id=c.id AND i.name='2 Soft Shell');
INSERT INTO items (category_id,name,description,sort,active,late_night) SELECT id,'Burrito','Meat, refried beans, shredded cheese, lettuce, onion, and tomato rolled up in a tortilla. Topped with shredded cheese, black olives, and enchilada sauce.',1,1,0 FROM categories c WHERE c.name='Mexican Night' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.category_id=c.id AND i.name='Burrito');
INSERT INTO items (category_id,name,description,sort,active,late_night) SELECT id,'Chimichanga','Meat, refried beans, shredded cheese, and onion rolled up in a tortilla and fried. Topped with enchilada sauce, black olives, and shredded cheese. Lettuce and tomato on the side.',2,1,0 FROM categories c WHERE c.name='Mexican Night' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.category_id=c.id AND i.name='Chimichanga');
INSERT INTO items (category_id,name,description,sort,active,late_night) SELECT id,'Enchilada','Meat, refried beans, shredded cheese, and onion rolled up in a tortilla. Topped with enchilada sauce, black olives, and shredded cheese. Lettuce and tomato on the side.',3,1,0 FROM categories c WHERE c.name='Mexican Night' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.category_id=c.id AND i.name='Enchilada');
INSERT INTO items (category_id,name,description,sort,active,late_night) SELECT id,'Nacho Deluxe','Meat, lettuce, onion, tomato, black olives, and nacho cheese served on top of chips.',4,1,0 FROM categories c WHERE c.name='Mexican Night' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.category_id=c.id AND i.name='Nacho Deluxe');
INSERT INTO items (category_id,name,description,sort,active,late_night) SELECT id,'Taco Salad','Meat, shredded cheese, lettuce, onion, tomato, and black olives served in a shell bowl.',5,1,0 FROM categories c WHERE c.name='Mexican Night' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.category_id=c.id AND i.name='Taco Salad');
INSERT INTO items (category_id,name,description,sort,active,late_night) SELECT id,'Chips & Salsa or Chips & Cheese','',6,1,0 FROM categories c WHERE c.name='Mexican Night' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.category_id=c.id AND i.name='Chips & Salsa or Chips & Cheese');

INSERT INTO items (category_id, name, description, sort, active, late_night)
SELECT 9, v.name, v.description, v.sort, 1, 0 FROM (
 SELECT '2 Grilled Cheese & French Fries' AS name, '' AS description, 1 AS sort
 UNION ALL SELECT '5 Mini Corn Dogs & French Fries', '', 3
 UNION ALL SELECT 'Lite Salad', 'Any Salad, See Salads', 5
) v WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.category_id = 9 AND i.name = v.name);
UPDATE items SET sort = 2 WHERE id = 71 AND category_id = 9 AND name = '2 Chicken Strips & French Fries';
UPDATE items SET sort = 4 WHERE id = 72 AND category_id = 9 AND name = 'Chicken Quesadilla';
