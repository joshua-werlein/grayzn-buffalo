// The Worker owns only automatic writes. Manual saves remain in specials-store.ts.
// Every write, revision bump and acceptance audit commits in one D1 batch.
export async function guardedAutoWrite(env, {importId, classification, candidateJson, today, weekday}) {
  const stage = reason => ({written:false, reason});
  if (classification.kind !== 'week' || classification.day !== weekday || !['lunch','nightly','all-day'].includes(classification.service)) return stage('Caption is not explicit for today');
  const groups = JSON.parse(candidateJson);
  // Repeated All Day evidence may accompany Mon/Fri graphics, but only the
  // caption's explicit service is authorized for automatic publication.
  if (groups.some(g => g.day_of_week !== weekday || (g.service !== classification.service && !([1,5].includes(weekday) && g.service === 'all-day')))) return stage('Extraction does not match caption');
  const targets = groups.filter(g => g.service === classification.service);
  if (targets.length !== 1 || !targets[0].items.length) return stage('No unique populated target in extraction');
  const target = targets[0];
  const {results:weeks} = await env.DB.prepare(`SELECT w.id,c.id collection_id,c.revision FROM weekly_specials w
    LEFT JOIN special_collections c ON c.weekly_special_id=w.id AND c.kind='week'
    WHERE w.week_start_date<=?1 AND w.week_end_date>=?1`).bind(today).all();
  if (weeks.length !== 1 || !weeks[0].collection_id) return stage('No unique current saved week');
  const week = weeks[0];
  const {results:destinations} = await env.DB.prepare(`SELECT id,enabled FROM special_groups
    WHERE collection_id=?1 AND day_of_week=?2 AND service=?3`).bind(week.collection_id,weekday,target.service).all();
  if (destinations.length !== 1 || destinations[0].enabled !== 1) return stage('No unique enabled destination group');
  const groupId = destinations[0].id;
  const {results:slots} = await env.DB.prepare('SELECT * FROM special_slots WHERE group_id=?1 ORDER BY position').bind(groupId).all();
  const safe = slot => slot && slot.manual_locked === 0 && slot.origin !== 'manual' && slot.price === '' && slot.section_link === '' && (
    ((slot.content === '' || slot.content === null) && (slot.last_auto_value === null || slot.last_auto_value === slot.content)) ||
    (slot.origin === 'automation' && typeof slot.last_auto_value === 'string' && slot.content === slot.last_auto_value)
  );
  const rows = target.items.map((item,i) => ({position:i+1, content:item.content, old:slots.find(s=>s.position === i+1)}));
  if (rows.some(row => !safe(row.old))) return stage('Destination has a manual lock, manual content or changed baseline');
  if (rows.every(row => row.old.content === row.content && row.old.origin === 'automation' && row.old.last_auto_value === row.content)) return stage('Automatic values already match');
  const token = crypto.randomUUID();
  const prepare = (sql,...args) => env.DB.prepare(sql).bind(...args);
  // Snapshot comparisons also protect against out-of-band slot edits that did
  // not bump revision. An absent/overlapping week or changed group fails closed.
  const snapshot = JSON.stringify(rows.map(({old}) => old));
  const claim = prepare(`UPDATE special_collections SET revision=revision+1,mutation_token=?1
    WHERE id=?2 AND revision=?3 AND kind='week' AND weekly_special_id=?4
    AND EXISTS(SELECT 1 FROM special_migration_checks WHERE version=15 AND mismatches=0)
    AND (SELECT count(*) FROM weekly_specials WHERE week_start_date<=?5 AND week_end_date>=?5)=1
    AND EXISTS(SELECT 1 FROM weekly_specials WHERE id=?4 AND week_start_date<=?5 AND week_end_date>=?5)
    AND (SELECT count(*) FROM special_groups WHERE collection_id=?2 AND day_of_week=?6 AND service=?7)=1
    AND EXISTS(SELECT 1 FROM special_groups WHERE id=?8 AND collection_id=?2 AND day_of_week=?6 AND service=?7 AND enabled=1)
    AND EXISTS(SELECT 1 FROM special_imports WHERE id=?9 AND review_status='pending' AND processing_status='staged'
      AND validation_result='ok' AND image_r2_key IS NOT NULL AND candidate_json=?10)
    AND (SELECT count(*) FROM json_each(?11) j JOIN special_slots s
      ON s.group_id=?8 AND s.position=json_extract(j.value,'$.position')
      WHERE s.content IS json_extract(j.value,'$.content') AND s.price='' AND s.section_link=''
        AND s.origin=json_extract(j.value,'$.origin') AND s.manual_locked=0
        AND s.last_auto_value IS json_extract(j.value,'$.last_auto_value'))=?12`,
    token,week.collection_id,week.revision,week.id,today,weekday,target.service,groupId,importId,candidateJson,snapshot,rows.length);
  const gate = 'EXISTS(SELECT 1 FROM special_collections WHERE id=?1 AND mutation_token=?2)';
  const reviewStatus = groups.length === 1 ? 'accepted' : 'pending';
  const detail = `GUARDED_AUTO: ${today} ${target.service}; ${rows.length} item(s)${reviewStatus === 'pending' ? '; other groups still need review' : ''}`;
  const results = await env.DB.batch([
    claim,
    ...rows.map(row => prepare(`UPDATE special_slots SET content=?3,price='',origin='automation',manual_locked=0,last_auto_value=?3
      WHERE group_id=?4 AND position=?5 AND ${gate}`,week.collection_id,token,row.content,groupId,row.position)),
    prepare(`UPDATE weekly_specials SET updated_at=CURRENT_TIMESTAMP WHERE id=?3 AND ${gate}`,week.collection_id,token,week.id),
    prepare(`UPDATE special_imports SET review_status=?5,review_reason=?4,reviewed_at=CASE WHEN ?5='accepted' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?3 AND ${gate}`,
      week.collection_id,token,importId,detail,reviewStatus),
    prepare(`INSERT INTO special_import_events(import_id,event_type,detail) SELECT ?3,'review',?4 WHERE ${gate}`,
      week.collection_id,token,importId,detail),
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
