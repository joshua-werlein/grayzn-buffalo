// Shared whole-collection protection: a complete poster replaces the whole menu,
// so one protected item must block the entire replacement, not just that item.
export const protectedMexicanSlots = `EXISTS(SELECT 1 FROM special_slots s
  JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night'
  AND (s.manual_locked<>0 OR NOT (
    (s.origin='manual' AND s.manual_locked=0) OR
    (s.origin='automation' AND s.content IS s.last_auto_value) OR
    (COALESCE(s.content,'')='' AND s.last_auto_value IS NULL))))`;

export function mexicanNightSeedStatements(env,{start,end,now}) {
  const token=crypto.randomUUID();
  const prepare=(sql,...args)=>env.DB.prepare(sql).bind(...args);
  const gate="EXISTS(SELECT 1 FROM special_collections WHERE id='mexican-night' AND mutation_token=?1)";
  // All reads and writes run inside ensureAutomaticWeek's D1 transaction.
  // Existing exact weeks can repair a missing publication, but never reset it.
  // Live locks protect their associated week only. An expired week always starts
  // fresh from the current recurring template, regardless of its former source.
  return [
    prepare(`UPDATE special_collections SET
      title=(SELECT title FROM special_collections WHERE id='mexican-night-defaults'),
      schedule=(SELECT schedule FROM special_collections WHERE id='mexican-night-defaults'),
      section_week_start=?2,section_service_date=date(?2,'+1 day'),section_source='recurring',
      updated_at=?4,revision=revision+1,mutation_token=?1
      WHERE id='mexican-night' AND kind='section'
      AND (section_week_start IS NULL OR section_week_start<?2)
      AND EXISTS(SELECT 1 FROM special_migration_checks WHERE version=15 AND mismatches=0)
      AND (SELECT count(*) FROM weekly_specials WHERE week_start_date<=?3 AND week_end_date>=?2)=1
      AND EXISTS(SELECT 1 FROM weekly_specials w JOIN special_collections c ON c.weekly_special_id=w.id
        WHERE w.week_start_date=?2 AND w.week_end_date=?3 AND c.kind='week')
      AND EXISTS(SELECT 1 FROM special_collections WHERE id='mexican-night-defaults' AND kind='section')
      AND EXISTS(SELECT 1 FROM special_groups g JOIN special_slots s ON s.group_id=g.id
        WHERE g.collection_id='mexican-night-defaults' AND g.enabled=1 AND trim(COALESCE(s.content,''))<>'')
      AND NOT EXISTS(SELECT 1 FROM special_groups g WHERE g.collection_id='mexican-night-defaults'
        AND (g.day_of_week<>-1 OR (SELECT count(*) FROM special_slots WHERE group_id=g.id)<>4))
      AND (section_week_start<?2 OR (
        COALESCE(section_source,'')<>'manual' AND (NOT ${protectedMexicanSlots} OR (
        section_source='recurring' AND updated_at IS NULL AND section_week_start IS NULL
        AND revision=(SELECT revision FROM special_collections WHERE id='mexican-night-defaults')
        AND (SELECT count(*) FROM special_groups WHERE collection_id='mexican-night')=
            (SELECT count(*) FROM special_groups WHERE collection_id='mexican-night-defaults')
        AND NOT EXISTS(SELECT 1 FROM special_groups g WHERE g.collection_id='mexican-night'
          AND NOT EXISTS(SELECT 1 FROM special_groups d WHERE d.id='mn-default:'||g.id
            AND d.collection_id='mexican-night-defaults' AND d.label=g.label AND d.enabled=g.enabled
            AND d.sort=g.sort AND d.service_time=g.service_time))
        AND (SELECT count(*) FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night')=
            (SELECT count(*) FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night-defaults')
        AND NOT EXISTS(SELECT 1 FROM special_slots s JOIN special_groups g ON g.id=s.group_id
          WHERE g.collection_id='mexican-night' AND NOT EXISTS(SELECT 1 FROM special_slots d
            WHERE d.group_id='mn-default:'||s.group_id AND d.position=s.position
            AND d.content IS s.content AND d.price=s.price AND d.section_link=s.section_link
            AND d.origin=s.origin AND d.manual_locked=s.manual_locked AND d.last_auto_value IS s.last_auto_value))
      ))))`,token,start,end,now),
    prepare(`DELETE FROM special_groups WHERE collection_id='mexican-night' AND ${gate}`,token),
    prepare(`INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled)
      SELECT 'mn-live:'||id,'mexican-night',day_of_week,service,label,service_time,sort,enabled
      FROM special_groups WHERE collection_id='mexican-night-defaults' AND ${gate}`,token),
    prepare(`INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value)
      SELECT 'mn-live:'||s.group_id,s.position,COALESCE(s.content,''),s.price,s.section_link,'manual',0,NULL
      FROM special_slots s JOIN special_groups g ON g.id=s.group_id
      WHERE g.collection_id='mexican-night-defaults' AND ${gate}`,token),
  ];
}
