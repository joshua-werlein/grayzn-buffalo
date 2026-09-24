// The Worker owns only automatic writes. Manual saves remain in specials-store.ts.
// Every write, revision bump and acceptance audit commits in one D1 batch.
import {reconcilePosters} from './reconcile.js';
import {PARSER_VERSION} from './classify.js';

export async function reconcileToday(env,{sourceIds,today,weekday}) {
  const stage=reason=>({written:false,reason});
  if (!sourceIds.length) return stage('No current sources');
  const {results:sources}=await env.DB.prepare(`SELECT * FROM special_imports WHERE id IN (SELECT value FROM json_each(?1))
    AND parser_version=?2 AND processing_status='staged' AND validation_result='ok'
    AND image_r2_key IS NOT NULL AND review_status IN ('pending','accepted')`).bind(JSON.stringify(sourceIds),PARSER_VERSION).all();
  if (!sources.length) return stage('No extracted evidence');
  const {results:weeks}=await env.DB.prepare(`SELECT w.id,c.id collection_id,c.revision FROM weekly_specials w
    LEFT JOIN special_collections c ON c.weekly_special_id=w.id AND c.kind='week'
    WHERE w.week_start_date<=?1 AND w.week_end_date>=?1`).bind(today).all();
  if (weeks.length!==1 || !weeks[0].collection_id) return stage('No unique current saved week');
  const week=weeks[0];
  const {results:groups}=await env.DB.prepare('SELECT * FROM special_groups WHERE collection_id=?1 AND day_of_week=?2').bind(week.collection_id,weekday).all();
  const {results:slots}=await env.DB.prepare(`SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id
    WHERE g.collection_id=?1 AND g.day_of_week=?2 ORDER BY s.position`).bind(week.collection_id,weekday).all();
  const safe=s=>s && s.manual_locked===0 && s.origin!=='manual' && s.price==='' && s.section_link==='' && (
    ((s.content==='' || s.content===null) && (s.last_auto_value===null || s.last_auto_value===s.content)) ||
    (s.origin==='automation' && typeof s.last_auto_value==='string' && s.content===s.last_auto_value));
  const allDayGroups=groups.filter(g=>g.service==='all-day' && g.enabled===1);
  const existing=allDayGroups.length===1 ? slots.filter(s=>s.group_id===allDayGroups[0].id && s.content && safe(s) && s.origin==='automation') : [];
  const targets=reconcilePosters(sources.map(s=>JSON.parse(s.candidate_json)),weekday,existing);
  const rows=[];
  for (const target of targets) {
    const destinations=groups.filter(g=>g.service===target.service);
    if (destinations.length!==1 || destinations[0].enabled!==1) continue;
    const dest=destinations[0];
    const proposed=target.items.map((item,i)=>({group_id:dest.id,position:i+1,content:item.content,old:slots.find(s=>s.group_id===dest.id && s.position===i+1)}));
    if (proposed.some(r=>!safe(r.old))) continue;
    // Never leave a third/fourth existing value alongside a complete new group.
    if (slots.some(s=>s.group_id===dest.id && s.position>proposed.length && s.content)) continue;
    rows.push(...proposed.filter(r=>r.old.content!==r.content || r.old.origin!=='automation' || r.old.last_auto_value!==r.content));
  }
  if (!rows.length) return stage('No unambiguous eligible changes');
  const token=crypto.randomUUID();
  const prepare=(sql,...args)=>env.DB.prepare(sql).bind(...args);
  // Snapshot ALL evidence and today's groups/slots, including the All Day pair
  // used to remove repeats. A manual edit to that pair invalidates the plan too.
  const claim=prepare(`UPDATE special_collections SET revision=revision+1,mutation_token=?1
    WHERE id=?2 AND revision=?3 AND kind='week' AND weekly_special_id=?4
    AND EXISTS(SELECT 1 FROM special_migration_checks WHERE version=15 AND mismatches=0)
    AND (SELECT count(*) FROM weekly_specials WHERE week_start_date<=?5 AND week_end_date>=?5)=1
    AND EXISTS(SELECT 1 FROM weekly_specials WHERE id=?4 AND week_start_date<=?5 AND week_end_date>=?5)
    AND (SELECT count(*) FROM special_groups WHERE collection_id=?2 AND day_of_week=?6)=json_array_length(?7)
    AND NOT EXISTS(SELECT 1 FROM json_each(?7) j WHERE NOT EXISTS(SELECT 1 FROM special_groups g
      WHERE g.id=json_extract(j.value,'$.id') AND g.collection_id=?2 AND g.day_of_week=?6
      AND g.service=json_extract(j.value,'$.service') AND g.enabled=json_extract(j.value,'$.enabled')))
    AND (SELECT count(*) FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id=?2 AND g.day_of_week=?6)=json_array_length(?8)
    AND NOT EXISTS(SELECT 1 FROM json_each(?8) j WHERE NOT EXISTS(SELECT 1 FROM special_slots s
      WHERE s.group_id=json_extract(j.value,'$.group_id') AND s.position=json_extract(j.value,'$.position')
      AND s.content IS json_extract(j.value,'$.content') AND s.price=json_extract(j.value,'$.price')
      AND s.section_link=json_extract(j.value,'$.section_link') AND s.origin=json_extract(j.value,'$.origin')
      AND s.manual_locked=json_extract(j.value,'$.manual_locked') AND s.last_auto_value IS json_extract(j.value,'$.last_auto_value')))
    AND NOT EXISTS(SELECT 1 FROM json_each(?9) j WHERE NOT EXISTS(SELECT 1 FROM special_imports i
      WHERE i.id=json_extract(j.value,'$.id') AND i.candidate_json=json_extract(j.value,'$.candidate_json')
      AND i.processing_status='staged' AND i.validation_result='ok' AND i.review_status=json_extract(j.value,'$.review_status')
      AND i.image_r2_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM special_imports newer
        WHERE newer.fb_post_id=i.fb_post_id AND newer.parser_version=i.parser_version AND newer.rowid>i.rowid)))`,
    token,week.collection_id,week.revision,week.id,today,weekday,JSON.stringify(groups),JSON.stringify(slots),JSON.stringify(sources));
  const gate='EXISTS(SELECT 1 FROM special_collections WHERE id=?1 AND mutation_token=?2)';
  const detail=`GUARDED_AUTO: ${today}; reconciled ${sources.length} source(s); ${rows.length} slot(s)`;
  const results=await env.DB.batch([
    claim,
    ...rows.map(r=>prepare(`UPDATE special_slots SET content=?3,price='',origin='automation',manual_locked=0,last_auto_value=?3
      WHERE group_id=?4 AND position=?5 AND ${gate}`,week.collection_id,token,r.content,r.group_id,r.position)),
    prepare(`UPDATE weekly_specials SET updated_at=CURRENT_TIMESTAMP WHERE id=?3 AND ${gate}`,week.collection_id,token,week.id),
    // Evidence remains staged and reusable even after a partial publication.
    ...sources.map(s=>prepare(`INSERT INTO special_import_events(import_id,event_type,detail) SELECT ?3,'review',?4 WHERE ${gate}`,week.collection_id,token,s.id,detail)),
    prepare('SELECT id FROM special_collections WHERE id=?1 AND mutation_token=?2',week.collection_id,token),
  ]);
  return results.at(-1)?.results?.length ? {written:true,reason:detail} : stage('Concurrent change; nothing written');
}

export async function pruneImportHistory(env, now) {
  // Migration 0017 has ON DELETE CASCADE; explicit event deletion also works
  // with FK enforcement enabled. No specials table is part of this cleanup.
  const cutoff = new Date(now.getTime() - 90*24*60*60*1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM special_import_events WHERE import_id IN
      (SELECT id FROM special_imports WHERE julianday(fetched_at)<julianday(?1))`).bind(cutoff),
    env.DB.prepare('DELETE FROM special_imports WHERE julianday(fetched_at)<julianday(?1)').bind(cutoff),
  ]);
}
