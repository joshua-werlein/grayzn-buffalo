// Runs inside ensureAutomaticWeek's D1 transaction. Same-week reruns never reset
// staff or Facebook content. An expired week always starts fresh from the current
// recurring template; persistent corrections belong in the recurring defaults.
export function wingWednesdaySeedStatements(env,{start,end,now}) {
  const token=crypto.randomUUID();
  const prepare=(sql,...args)=>env.DB.prepare(sql).bind(...args);
  const gate="EXISTS(SELECT 1 FROM special_collections WHERE id='wing-wednesday' AND mutation_token=?1)";
  return [
    prepare(`UPDATE special_collections SET
      title=(SELECT title FROM special_collections WHERE id='wing-wednesday-defaults'),
      schedule=(SELECT schedule FROM special_collections WHERE id='wing-wednesday-defaults'),
      section_week_start=?2,section_service_date=date(?2,'+2 day'),section_source='recurring',
      updated_at=?4,revision=revision+1,mutation_token=?1
      WHERE id='wing-wednesday' AND kind='section'
      AND (section_week_start IS NULL OR section_week_start<?2)
      AND EXISTS(SELECT 1 FROM special_migration_checks WHERE version=15 AND mismatches=0)
      AND (SELECT count(*) FROM weekly_specials WHERE week_start_date<=?3 AND week_end_date>=?2)=1
      AND EXISTS(SELECT 1 FROM weekly_specials w JOIN special_collections c ON c.weekly_special_id=w.id
        WHERE w.week_start_date=?2 AND w.week_end_date=?3 AND c.kind='week')
      AND EXISTS(SELECT 1 FROM special_groups g JOIN special_slots s ON s.group_id=g.id
        WHERE g.collection_id='wing-wednesday-defaults' AND g.enabled=1 AND trim(COALESCE(s.content,''))<>'')
      AND NOT EXISTS(SELECT 1 FROM special_groups g WHERE g.collection_id='wing-wednesday-defaults'
        AND (g.day_of_week<>-1 OR (SELECT count(*) FROM special_slots WHERE group_id=g.id)<>4))
      AND NOT EXISTS(SELECT 1 FROM special_slots s JOIN special_groups g ON g.id=s.group_id
        WHERE g.collection_id='wing-wednesday-defaults' AND (trim(s.price)<>'' OR s.content LIKE '%$%'))`,token,start,end,now),
    prepare(`DELETE FROM special_groups WHERE collection_id='wing-wednesday' AND ${gate}`,token),
    prepare(`INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled)
      SELECT 'ww-live:'||id,'wing-wednesday',day_of_week,service,label,service_time,sort,enabled
      FROM special_groups WHERE collection_id='wing-wednesday-defaults' AND ${gate}`,token),
    prepare(`INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value)
      SELECT 'ww-live:'||s.group_id,s.position,COALESCE(s.content,''),'',s.section_link,'manual',0,NULL
      FROM special_slots s JOIN special_groups g ON g.id=s.group_id
      WHERE g.collection_id='wing-wednesday-defaults' AND ${gate}`,token),
  ];
}
