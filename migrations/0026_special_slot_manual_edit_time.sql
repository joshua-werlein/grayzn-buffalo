-- When staff last edited a weekly slot. An unlocked staff edit may be replaced
-- only by a Facebook post verified as newer than this time. NULL means no recorded
-- edit: recurring defaults, automation values and all existing rows. This migration
-- changes no value and removes no lock.
ALTER TABLE special_slots ADD COLUMN manual_edited_at TEXT;
