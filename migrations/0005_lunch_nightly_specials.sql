-- Add separately managed Lunch and Nightly specials to each weekday.
-- Existing daily specials become the initial Nightly entries, preserving the
-- names, descriptions, and tags already entered by staff.
ALTER TABLE specials ADD COLUMN lunch_name TEXT NOT NULL DEFAULT '';
ALTER TABLE specials ADD COLUMN lunch_description TEXT NOT NULL DEFAULT '';
ALTER TABLE specials ADD COLUMN lunch_tag TEXT DEFAULT NULL;
ALTER TABLE specials ADD COLUMN night_name TEXT NOT NULL DEFAULT '';
ALTER TABLE specials ADD COLUMN night_description TEXT NOT NULL DEFAULT '';
ALTER TABLE specials ADD COLUMN night_tag TEXT DEFAULT NULL;

UPDATE specials
SET night_name = name,
    night_description = description,
    night_tag = tag
WHERE night_name = '';
