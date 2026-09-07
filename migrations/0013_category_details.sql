-- Add reusable public section details. Apply once to existing databases.
ALTER TABLE categories ADD COLUMN subtitle TEXT NOT NULL DEFAULT '';
ALTER TABLE categories ADD COLUMN note TEXT NOT NULL DEFAULT '';
