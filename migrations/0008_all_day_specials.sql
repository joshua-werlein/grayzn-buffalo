-- Add an All Day special that can coexist alongside Lunch and Nightly.
-- No backfill: unlike Lunch/Nightly, there is no legacy data for this period.
ALTER TABLE specials ADD COLUMN allday_name TEXT NOT NULL DEFAULT '';
ALTER TABLE specials ADD COLUMN allday_description TEXT NOT NULL DEFAULT '';
ALTER TABLE specials ADD COLUMN allday_tag TEXT DEFAULT NULL;
