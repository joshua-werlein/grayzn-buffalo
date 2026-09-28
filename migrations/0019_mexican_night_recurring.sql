-- Preserve the existing unpublished Mexican Night menu as its recurring template.
-- Never infer defaults from already-published Facebook/staff content.
ALTER TABLE special_collections ADD COLUMN section_week_start TEXT;
ALTER TABLE special_collections ADD COLUMN section_service_date TEXT;
ALTER TABLE special_collections ADD COLUMN section_source TEXT
  CHECK(section_source IN ('recurring','facebook','manual'));
INSERT INTO special_collections(id,kind,title,schedule,revision)
SELECT 'mexican-night-defaults','section',title,schedule,revision
FROM special_collections WHERE id='mexican-night' AND updated_at IS NULL
AND NOT EXISTS(SELECT 1 FROM special_slots s JOIN special_groups g ON g.id=s.group_id
  WHERE g.collection_id='mexican-night' AND s.origin='automation');
INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled)
SELECT 'mn-default:'||id,'mexican-night-defaults',day_of_week,service,label,service_time,sort,enabled
FROM special_groups WHERE collection_id='mexican-night'
AND EXISTS(SELECT 1 FROM special_collections WHERE id='mexican-night-defaults');
INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value)
SELECT 'mn-default:'||s.group_id,s.position,s.content,s.price,s.section_link,s.origin,s.manual_locked,s.last_auto_value
FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night'
AND EXISTS(SELECT 1 FROM special_collections WHERE id='mexican-night-defaults');
-- Marks only the original unpublished baseline; leaves its values and locks intact.
-- A subsequent staff save marks it manual and disqualifies bootstrap publication.
UPDATE special_collections SET section_source='recurring' WHERE id='mexican-night'
AND EXISTS(SELECT 1 FROM special_collections WHERE id='mexican-night-defaults');
