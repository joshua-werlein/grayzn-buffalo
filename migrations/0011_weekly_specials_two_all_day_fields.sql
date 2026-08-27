-- 0009 is already live with one legacy all-day field. Preserve it, add the
-- two structured fields, and carry existing content into the first field.
ALTER TABLE weekly_special_days
  ADD COLUMN all_day_1_content TEXT NOT NULL DEFAULT '';

ALTER TABLE weekly_special_days
  ADD COLUMN all_day_2_content TEXT NOT NULL DEFAULT '';

UPDATE weekly_special_days
SET all_day_1_content = allday_content
WHERE all_day_1_content = '';
