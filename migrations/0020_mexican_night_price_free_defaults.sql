-- Data only: exact recurring-template values inspected in production on 2026-10-05.
-- Never read from or update the live mexican-night collection or its protection.
-- Unknown/edited text is deliberately left for review, never broadly stripped.
-- Run through the transactional migration runner only after review/approval.
WITH replacements(old_content,new_content) AS (VALUES
  ('2 Soft Shell - $7.75 ' || char(10) || 'Meat, shredded cheese, lettuce, onion, tomato & black olives.','2 Soft Shell' || char(10) || 'Meat, shredded cheese, lettuce, onion, tomato & black olives.'),
  ('Burrito - $10.25' || char(10) || 'Meat, refried beans, shredded cheese, lettuce, onion & tomato, topped with cheese, olives & enchilada sauce.','Burrito' || char(10) || 'Meat, refried beans, shredded cheese, lettuce, onion & tomato, topped with cheese, olives & enchilada sauce.'),
  ('Chimichanga - $12.25' || char(10) || 'Meat, refried beans, shredded cheese & onion, fried and topped with enchilada sauce, olives & cheese.','Chimichanga' || char(10) || 'Meat, refried beans, shredded cheese & onion, fried and topped with enchilada sauce, olives & cheese.'),
  ('Enchilada - $9.25 ' || char(10) || 'Meat, refried beans, shredded cheese & onion, topped with enchilada sauce, olives & cheese.','Enchilada' || char(10) || 'Meat, refried beans, shredded cheese & onion, topped with enchilada sauce, olives & cheese.'),
  ('Nacho Deluxe - $9.75 ' || char(10) || 'Meat, lettuce, onion, tomato, black olives & nacho cheese over chips.','Nacho Deluxe' || char(10) || 'Meat, lettuce, onion, tomato, black olives & nacho cheese over chips.'),
  ('Taco Salad | Large $9.00 · Small $8.50 · Mini $6.00 ' || char(10) || 'Meat, shredded cheese, lettuce, onion, tomato & black olives.','Taco Salad | Large · Small · Mini' || char(10) || 'Meat, shredded cheese, lettuce, onion, tomato & black olives.'),
  ('Chips & Salsa or Chips & Cheese - $4.00 ' || char(10) || 'Add nacho cheese or salsa +$1.50','Chips & Salsa or Chips & Cheese' || char(10) || 'Add nacho cheese or salsa'),
  ('Substitute chicken +$1.50','Substitute chicken'),
  ('Add nacho cheese +$1.50','Add nacho cheese'),
  ('Substitute queso +$0.50','Substitute queso'),
  ('Substitute shredded cheese for nacho cheese +$0.50','Substitute shredded cheese for nacho cheese')
)
UPDATE special_slots SET content=(SELECT new_content FROM replacements WHERE old_content=special_slots.content),price=''
WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id='mexican-night-defaults')
AND price='' AND content IN (SELECT old_content FROM replacements);
-- Invalidate any editor opened before the cleanup. Reapplying is a no-op.
UPDATE special_collections SET revision=revision+1,updated_at=CURRENT_TIMESTAMP
WHERE id='mexican-night-defaults' AND changes()>0;
