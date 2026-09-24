export function automaticWeekRange(today,weekday,hour) {
  const offset=weekday===0 && hour>=19 ? 1 : -((weekday+6)%7);
  const date=new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate()+offset);
  const start=date.toISOString().slice(0,10);
  date.setUTCDate(date.getUTCDate()+6);
  return {start,end:date.toISOString().slice(0,10)};
}

export async function ensureAutomaticWeek(env,{today,weekday,hour}) {
  if (env.SPECIALS_IMPORT_MODE!=='GUARDED_AUTO') return;
  const {start,end}=automaticWeekRange(today,weekday,hour);
  const words=crypto.getRandomValues(new Uint32Array(2));
  const id=(words[0]&0xffff)*4294967296+words[1]+1;
  const collectionId=crypto.randomUUID(), token=crypto.randomUUID();
  const prepare=(sql,...args)=>env.DB.prepare(sql).bind(...args);
  const gate='EXISTS(SELECT 1 FROM special_collections WHERE id=?1 AND mutation_token=?2)';
  // Read the template inside the transaction, so a simultaneous manual save
  // cannot produce a mixture of two template revisions. No schema changes.
  await env.DB.batch([
    prepare(`INSERT INTO weekly_specials(id,week_start_date,week_end_date)
      SELECT ?1,?2,?3 WHERE NOT EXISTS(SELECT 1 FROM weekly_specials WHERE week_start_date<=?3 AND week_end_date>=?2)
      AND EXISTS(SELECT 1 FROM special_migration_checks WHERE version=15 AND mismatches=0)
      AND EXISTS(SELECT 1 FROM special_collections WHERE id='defaults' AND kind='defaults')
      AND EXISTS(SELECT 1 FROM special_groups WHERE collection_id='defaults')
      AND NOT EXISTS(SELECT 1 FROM special_groups g WHERE collection_id='defaults'
        AND (day_of_week<0 OR (SELECT count(*) FROM special_slots WHERE group_id=g.id)<>4))`,id,start,end),
    prepare(`INSERT INTO special_collections(id,kind,weekly_special_id,revision,mutation_token)
      SELECT ?1,'week',?3,1,?2 WHERE EXISTS(SELECT 1 FROM weekly_specials WHERE id=?3 AND week_start_date=?4 AND week_end_date=?5)`,collectionId,token,id,start,end),
    prepare(`INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled)
      SELECT ?1||':'||id,?1,day_of_week,service,label,service_time,sort,enabled
      FROM special_groups WHERE collection_id='defaults' AND ${gate}`,collectionId,token),
    prepare(`INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value)
      SELECT ?1||':'||s.group_id,s.position,COALESCE(s.content,''),s.price,s.section_link,
        CASE WHEN COALESCE(s.content,'')='' AND s.price='' AND s.section_link='' THEN 'legacy' ELSE 'manual' END,
        CASE WHEN COALESCE(s.content,'')='' AND s.price='' AND s.section_link='' THEN 0 ELSE 1 END,NULL
      FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='defaults' AND ${gate}`,collectionId,token),
  ]);
}
