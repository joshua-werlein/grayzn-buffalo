-- One photo per menu item. Stores the full-size R2 key, e.g.
--   menu/12/9f8c1d2e-...-b7a3.webp
-- The 600px thumbnail key is derived from it (see thumbKey in db.ts).
ALTER TABLE items ADD COLUMN photo_key TEXT;