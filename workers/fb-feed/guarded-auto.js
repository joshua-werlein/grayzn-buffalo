import {mergeMexicanMenu, storedMexicanGroups, accessoryGroup, scheduleKey} from './mexican-menu.js';
import {protectedMexicanSlots} from './mexican-night-defaults.js';
import {automaticWeekRange} from './auto-week.js';
import {composeMexicanItem,normalizeMexicanPrices} from '../../src/lib/mexican-item.js';
import {normalizeMenuCase} from '../../src/lib/text-case.js';
// The Worker owns only automatic writes. Manual saves remain in specials-store.ts.
// Every write, revision bump and acceptance audit commits in one D1 batch.
import {reconcilePosterEvidence,validateWeeklyLunch,applySharedWeeklyLunchPrice,validateMexicanNight,canonicalizeSlotContent,singleDayLunchEvidence,singleDayLunchEvidenceV2} from './reconcile.js';
import {parserVersionFor} from './classify.js';
import {soupGroupId,blankSoupGroup} from '../../src/lib/daily-soup.js';
import {normalizeWeeklyRange,factKey,analyzeDailyEvidence,hasPrintedPrice} from './evidence.js';
import {approvalEvents,staffConfirmedCandidate} from './staff-review.js';
import {eventSourceIndexes} from './event-store.js';
import {NEWER_STAFF_EDIT} from './alert-detail.js';

// A staff edit records its time. Only a Facebook post verified as newer may replace
// it; recurring defaults and automation values have no edit time. Import processing
// time never counts.
const newerThanStaffEdit=(slot,postedMs)=>slot.manual_edited_at==null
  || (Number.isFinite(postedMs) && postedMs>Date.parse(slot.manual_edited_at));
const replaceableSlot=(s,postedMs)=>s && s.price==='' && s.section_link==='' && newerThanStaffEdit(s,postedMs) && (
  // Blank: eligible regardless of origin or lock. A value automation wrote and staff
  // later cleared stays clear, unless the clearing has a recorded time a newer post beat.
  ((s.content==='' || s.content===null) && (s.last_auto_value===null || s.last_auto_value===s.content || s.manual_edited_at!=null)) ||
  // Prior automation value, unchanged and not locked.
  (s.origin==='automation' && typeof s.last_auto_value==='string' && s.content===s.last_auto_value && s.manual_locked===0) ||
  // Unlocked manual value: a recurring default from newWeekFromDefaults(), or a staff edit.
  (s.origin==='manual' && s.manual_locked===0));

// When each source's poster was verifiably posted. A Facebook updated time alone
// proves nothing: comments can change it. It counts only for a version whose stored
// image or caption actually differs from the post's earlier version.
async function verifiedPostTimes(env,sources) {
  const posts=[...new Set(sources.map(s=>s.fb_post_id))];
  const {results:versions}=await env.DB.prepare(`SELECT id,fb_post_id,fb_created_time,fb_updated_time,image_hash,caption_hash
    FROM special_imports WHERE fb_post_id IN (SELECT value FROM json_each(?1)) ORDER BY rowid`).bind(JSON.stringify(posts)).all();
  const times=new Map(),state=new Map();
  for(const v of versions) {
    const prior=state.get(v.fb_post_id);
    const changed=prior && v.image_hash && prior.image_hash && (v.image_hash!==prior.image_hash || v.caption_hash!==prior.caption_hash);
    const time=!prior?Date.parse(v.fb_created_time):changed?Date.parse(v.fb_updated_time):prior.time;
    state.set(v.fb_post_id,{time,image_hash:v.image_hash ?? prior?.image_hash,caption_hash:v.caption_hash});
    times.set(v.id,time<=Date.now()?time:NaN);
  }
  return times;
}

export async function reconcileToday(env,{sourceIds,today,weekday,inspectOnly=false}) {
  const stage=reason=>({written:false,reason});
  if (!sourceIds.length) return stage('No current sources');
  const unresolved=`EXISTS(SELECT 1 FROM special_imports WHERE id IN (SELECT value FROM json_each(?1))
    AND review_status='pending' AND processing_status IN ('pending','processing'))`;
  if (await env.DB.prepare(`SELECT 1 WHERE ${unresolved}`).bind(JSON.stringify(sourceIds)).first()) {
    // In observation mode, a current retry pauses an older queued incident.
    // Failure to obtain monitoring context must not affect reconciliation.
    if(env.SPECIALS_ALERT_MODE==='OBSERVE') try {
      const {results:sources}=await env.DB.prepare(`SELECT * FROM special_imports
        WHERE id IN (SELECT value FROM json_each(?1)) AND parser_version=?2`)
        .bind(JSON.stringify(sourceIds),parserVersionFor(env)).all();
      const {results:weeks}=await env.DB.prepare(`SELECT c.id,c.revision FROM weekly_specials w
        JOIN special_collections c ON c.weekly_special_id=w.id AND c.kind='week'
        WHERE w.week_start_date<=?1 AND w.week_end_date>=?1`).bind(today).all();
      if(weeks.length===1) return {...stage('Current sources awaiting recovery'),alertSnapshot:{
        sources,sourceIds,currentSourceIds:sourceIds,parser:parserVersionFor(env),
        collectionId:weeks[0].id,revision:weeks[0].revision}};
    } catch { console.error('Daily pending observation unavailable'); }
    return stage('Current sources awaiting recovery');
  }
  const {results:storedSources}=await env.DB.prepare(`SELECT * FROM special_imports WHERE id IN (SELECT value FROM json_each(?1))
    AND parser_version=?2 AND ((processing_status='staged' AND validation_result='ok')
      OR (processing_status='failed' AND validation_result='rejected' AND extracted_json IS NOT NULL))
    AND image_r2_key IS NOT NULL AND review_status IN ('pending','accepted')`).bind(JSON.stringify(sourceIds),parserVersionFor(env)).all();
  const dateOf = value => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
  // Keep excluded sources in the guarded audit instead of silently dropping them.
  // Publication below fails closed if any source timestamp is ineligible.
  // Whole-poster special events (SPECIAL_EVENTS_MODE=AUTO) belong to the
  // event reconciler. They never block, join or alert on the daily specials.
  const events=await eventSourceIndexes(env,storedSources,today);
  const eventSourceIds=storedSources.filter((_,i)=>events.has(i)).map(s=>s.id);
  const sources=storedSources.filter((_,i)=>!events.has(i));
  if (!sources.length) return {...stage('No extracted evidence'),...(eventSourceIds.length?{eventSourceIds,excludedSourceIds:eventSourceIds}:{})};
  const {results:weeks}=await env.DB.prepare(`SELECT w.id,c.id collection_id,c.revision FROM weekly_specials w
    LEFT JOIN special_collections c ON c.weekly_special_id=w.id AND c.kind='week'
    WHERE w.week_start_date<=?1 AND w.week_end_date>=?1`).bind(today).all();
  if (weeks.length!==1 || !weeks[0].collection_id) return stage('No unique current saved week');
  const week=weeks[0];
  const {results:groups}=await env.DB.prepare('SELECT * FROM special_groups WHERE collection_id=?1 AND day_of_week=?2').bind(week.collection_id,weekday).all();
  const {results:slots}=await env.DB.prepare(`SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id
    WHERE g.collection_id=?1 AND g.day_of_week=?2 ORDER BY s.position`).bind(week.collection_id,weekday).all();
  const allDayGroups=groups.filter(g=>g.service==='all-day' && g.enabled===1);
  const existing=allDayGroups.length===1 ? slots.filter(s=>s.group_id===allDayGroups[0].id && s.content && replaceableSlot(s) && s.origin==='automation') : [];
  const {results:staffEvents}=await env.DB.prepare(`SELECT import_id,event_type,detail FROM special_import_events
    WHERE import_id IN (SELECT value FROM json_each(?1)) AND event_type='review' AND detail LIKE 'STAFF_APPROVAL:%' ORDER BY id DESC LIMIT 240`).bind(JSON.stringify(sources.map(s=>s.id))).all();
  const candidates=sources.map(s=>{
    const json=s.processing_status==='failed' ? s.extracted_json : s.candidate_json;
    try { return staffConfirmedCandidate(JSON.parse(json.replace(/^```(?:json)?\n?|\n?```$/gm,'').trim()),approvalEvents(staffEvents.filter(e=>e.import_id===s.id)),groups,slots); }
    catch { return null; }
  });
  const slotLayout=slots.map(s=>({...s,service:groups.find(g=>g.id===s.group_id)?.service}));
  const verifiedSameDaySources=new Set(sources.flatMap((s,i)=>{
    const created=Date.parse(s.fb_created_time);
    return Number.isFinite(created) && created<=Date.now() && dateOf(s.fb_created_time)===today ? [i] : [];
  }));
  const postTimes=await verifiedPostTimes(env,sources);
  const {targets:proposedTargets,rejectedSources:rejected,unresolvedTargets=[],excludedSources=[],offeredBy}=reconcilePosterEvidence(candidates,weekday,existing,
    {today,slotLayout,verifiedSameDaySources,sourceTimes:sources.map(s=>postTimes.get(s.id))});
  // The newest post printing this offer. With no per-offer record, the oldest source.
  const postedAt=(service,content)=>{
    const indexes=offeredBy?.(service,content);
    const times=(indexes?.length?indexes:sources.map((_,i)=>i)).map(i=>postTimes.get(sources[i].id)).filter(Number.isFinite);
    return times.length ? (offeredBy ? Math.max(...times) : Math.min(...times)) : NaN;
  };
  const dailySourceIndices=new Set();
  sources.forEach((s,index)=>{
    // Contract 2 only: printed evidence placed this whole poster on another day.
    // Its stored import failure remains the audit record; it cannot block today.
    if (excludedSources.some(e=>e.index===index) && !rejected.some(r=>r.index===index)) return;
    const created=Date.parse(s.fb_created_time);
    if (!Number.isFinite(created) || created>Date.now() || dateOf(s.fb_created_time)!==today) {
      const reason='Facebook creation timestamp is invalid, future, or outside the current Chicago date';
      const prior=rejected.find(r=>r.index===index);
      if (prior) prior.reason=reason; else rejected.push({index,reason});
    }
    const c=candidates[index];
    let recoveredDaily=false;
    try { recoveredDaily=!!singleDayLunchEvidence(c); } catch { /* Reconciler already records invalid evidence. */ }
    let recoveredReliable=false;
    try {
      const daily=singleDayLunchEvidenceV2(c);
      recoveredReliable=!!daily && !analyzeDailyEvidence(daily).issues.some(i=>i.reason!=='Service not established by evidence');
    } catch { /* Invalid original evidence remains rejected. */ }
    const dedicated=['weekly-lunch','mexican-night'].includes(c?.type) && !('offers' in c) && !recoveredDaily;
    if(!dedicated) dailySourceIndices.add(index);
    const staffConfirmed=Array.isArray(c?.offers) && c.offers.length>0 && c.staff_confirmed_indices?.length===c.offers.length;
    if (s.processing_status==='failed' && !dedicated && !recoveredReliable && !staffConfirmed && !rejected.some(r=>r.index===index)) {
      rejected.push({index,reason:s.validation_reason || 'Rejected extracted evidence'});
    }
  });
  const targets=rejected.length ? [] : proposedTargets;
  const rejectedSources=rejected.map(r=>({source_id:sources[r.index].id,fb_post_id:sources[r.index].fb_post_id,reason:r.reason}));
  const rows=[],createdGroups=[],blocked=rejected.length ? [] : unresolvedTargets.map(t=>({...t,day_of_week:weekday,group_id:null}));
  for (const target of targets) {
    const soup=target.role==='soup';
    const soupId=soupGroupId(week.collection_id,weekday);
    const destinations=groups.filter(g=>soup ? g.id===soupId : g.service===target.service);
    if (soup && !destinations.length) {
      const group=blankSoupGroup(week.collection_id,weekday);
      createdGroups.push(group);
      rows.push({group_id:group.id,position:1,content:target.items[0].content,old:group.slots[0]});
      continue;
    }
    const block=(item,position,reason,group_id=null)=>blocked.push({day_of_week:weekday,service:target.service,group_id,position,content:item.content,reason});
    if (destinations.length!==1 || destinations[0].enabled!==1) {
      target.items.forEach((item,i)=>block(item,i+1,'Missing, disabled or ambiguous destination'));
      continue;
    }
    const dest=destinations[0];
    if (soup && (dest.service!=='custom' || dest.label!=='Soup' || dest.service_time!==''
      || slots.filter(s=>s.group_id===dest.id).length!==4)) {
      block(target.items[0],1,'Invalid reserved Soup destination',dest.id);
      continue;
    }
    const proposed=target.items.map((item,i)=>({group_id:dest.id,position:item.position??i+1,content:item.content,old:slots.find(s=>s.group_id===dest.id && s.position===(item.position??i+1))}));
    // Never leave a third/fourth existing value alongside a complete new group.
    // Same service capacities as the planner and staff editor (Friday Nightly: four).
    const capacity=target.service==='lunch'?1:target.service==='all-day'?2:target.service==='nightly'?(weekday===5?4:weekday===1?2:1):1;
    if (slots.some(s=>s.group_id===dest.id && s.position>(target.partial?capacity:proposed.length) && s.content)) {
      proposed.forEach(r=>block(r,r.position,'Additional existing slots prevent replacement',dest.id));
      continue;
    }
    const eligible=proposed.filter(r=>{
      const soupSafe=r.old && r.old.manual_locked===0 && r.old.price==='' && r.old.section_link===''
        && (!r.old.content || (r.old.origin==='manual' && r.old.last_auto_value===null)
          || (r.old.origin==='automation' && r.old.content===r.old.last_auto_value));
      const posted=soup?NaN:postedAt(target.service,r.content);
      if (soup ? soupSafe : replaceableSlot(r.old,posted)) return true;
      block(r,r.position,!soup && r.old && r.old.manual_locked===0 && !newerThanStaffEdit(r.old,posted) ? NEWER_STAFF_EDIT : 'Protected or ineligible destination slot',dest.id);
      return false;
    });
    rows.push(...eligible.filter(r=>r.old.content!==r.content || r.old.origin!=='automation' || r.old.last_auto_value!==r.content));
  }
  // Published meals with no printed price: the plan reproduces these on every
  // scan, so the alert needs no separate record. Soup is never priced.
  const pricelessOffers=targets.flatMap(t=>t.role==='soup'?[]:t.items.filter(item=>!hasPrintedPrice(item.content)).map(item=>({service:t.service,position:item.position})))
    .filter(p=>!blocked.some(b=>b.service===p.service && b.position===p.position));
  const conflictDetail=blocked.length || rejectedSources.length
    ? `GUARDED_AUTO_CONFLICT: ${today}; blocked proposals: ${JSON.stringify(blocked)}${rejectedSources.length ? `; rejected sources: ${JSON.stringify(rejectedSources)}` : ''}` : null;
  const dailySources=sources.filter((_,i)=>dailySourceIndices.has(i));
  // Only evaluated daily proposals/rejections establish publication coverage.
  // Dedicated weekly/Mexican no-ops must not resolve daily incidents.
  const withOutcome=(result,revision=week.revision)=>({...result,pricelessOffers,
    ...(targets.length || blocked.length || rejectedSources.length ? {alertSnapshot:{
      sources,sourceIds:sources.map(s=>s.id),currentSourceIds:sourceIds,
      parser:parserVersionFor(env),collectionId:week.collection_id,revision,
      intentionalBlockedIndices:blocked.flatMap((b,index)=>{
        const destinations=groups.filter(g=>g.service===b.service);
        const disabled=b.reason==='Missing, disabled or ambiguous destination' && destinations.length===1 && destinations[0].enabled===0;
        const protectedExtras=b.reason==='Additional existing slots prevent replacement'
          && slots.some(s=>s.group_id===b.group_id && s.manual_locked===1);
        return disabled || protectedExtras ? [index] : [];
      })}} : {})});
  // Monitoring uses the same proposal rules, without publication or audit writes.
  if (inspectOnly) return withOutcome({written:false,reason:rows.length?'Publication incomplete':'No unambiguous eligible changes',
    blocked,rejectedSources,requiresWrite:rows.length>0,excludedSourceIds:[...excludedSources.map(s=>sources[s.index].id),...eventSourceIds]});
  if (!rows.length) {
    if (!conflictDetail) return withOutcome(stage('No unambiguous eligible changes'));
    // Avoid revision/audit churn when a cron sees the same unresolved conflict.
    const {results:audited}=await env.DB.prepare(`SELECT import_id FROM special_import_events e
      WHERE import_id IN (SELECT value FROM json_each(?1)) AND event_type='review' AND detail=?2
      AND id=(SELECT MAX(id) FROM special_import_events WHERE import_id=e.import_id AND event_type='review')`)
      .bind(JSON.stringify(dailySources.map(s=>s.id)),conflictDetail).all();
    if (dailySources.every(s=>audited.some(e=>e.import_id===s.id))) return withOutcome({written:false,reason:conflictDetail,blocked,rejectedSources});
  }
  const token=crypto.randomUUID();
  const prepare=(sql,...args)=>env.DB.prepare(sql).bind(...args);
  // Snapshot ALL evidence and today's groups/slots, including the All Day pair
  // used to remove repeats. A manual edit to that pair invalidates the plan too.
  const claim=prepare(`UPDATE special_collections SET revision=revision+1,mutation_token=?1
    WHERE id=?2 AND revision=?3 AND kind='week' AND weekly_special_id=?4
    AND NOT EXISTS(SELECT 1 FROM special_imports WHERE id IN (SELECT value FROM json_each(?10))
      AND review_status='pending' AND processing_status IN ('pending','processing'))
    AND EXISTS(SELECT 1 FROM special_migration_checks WHERE version=15 AND mismatches=0)
    AND (SELECT count(*) FROM weekly_specials WHERE week_start_date<=?5 AND week_end_date>=?5)=1
    AND EXISTS(SELECT 1 FROM weekly_specials WHERE id=?4 AND week_start_date<=?5 AND week_end_date>=?5)
    AND (SELECT count(*) FROM special_groups WHERE collection_id=?2 AND day_of_week=?6)=json_array_length(?7)
    AND NOT EXISTS(SELECT 1 FROM json_each(?7) j WHERE NOT EXISTS(SELECT 1 FROM special_groups g
      WHERE g.id=json_extract(j.value,'$.id') AND g.collection_id=?2 AND g.day_of_week=?6
      AND g.service=json_extract(j.value,'$.service') AND g.enabled=json_extract(j.value,'$.enabled')
      AND g.label=json_extract(j.value,'$.label') AND g.service_time=json_extract(j.value,'$.service_time')
      AND g.sort=json_extract(j.value,'$.sort')))
    AND (SELECT count(*) FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id=?2 AND g.day_of_week=?6)=json_array_length(?8)
    AND NOT EXISTS(SELECT 1 FROM json_each(?8) j WHERE NOT EXISTS(SELECT 1 FROM special_slots s
      WHERE s.group_id=json_extract(j.value,'$.group_id') AND s.position=json_extract(j.value,'$.position')
      AND s.content IS json_extract(j.value,'$.content') AND s.price=json_extract(j.value,'$.price')
      AND s.section_link=json_extract(j.value,'$.section_link') AND s.origin=json_extract(j.value,'$.origin')
      AND s.manual_locked=json_extract(j.value,'$.manual_locked') AND s.last_auto_value IS json_extract(j.value,'$.last_auto_value')))
    AND NOT EXISTS(SELECT 1 FROM json_each(?9) j WHERE NOT EXISTS(SELECT 1 FROM special_imports i
      WHERE i.id=json_extract(j.value,'$.id') AND i.candidate_json IS json_extract(j.value,'$.candidate_json')
      AND i.extracted_json IS json_extract(j.value,'$.extracted_json')
      AND i.fb_created_time IS json_extract(j.value,'$.fb_created_time')
      AND i.processing_status=json_extract(j.value,'$.processing_status') AND i.validation_result=json_extract(j.value,'$.validation_result')
      AND i.review_status=json_extract(j.value,'$.review_status')
      AND i.image_r2_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM special_imports newer
        WHERE newer.fb_post_id=i.fb_post_id AND newer.parser_version=i.parser_version AND newer.rowid>i.rowid)))`,
    token,week.collection_id,week.revision,week.id,today,weekday,JSON.stringify(groups),JSON.stringify(slots),JSON.stringify(sources),JSON.stringify(sourceIds));
  const gate='EXISTS(SELECT 1 FROM special_collections WHERE id=?1 AND mutation_token=?2)';
  const detail=rejectedSources.length
    ? `GUARDED_AUTO: ${today}; no publication; CONFLICT: ${rejectedSources.length} rejected source(s), review required`
    : `GUARDED_AUTO: ${today}; reconciled ${sources.length} source(s); ${rows.length} slot(s)${blocked.length ? `; CONFLICT: ${blocked.length} blocked proposal(s), review required` : ''}`;
  const results=await env.DB.batch([
    claim,
    ...createdGroups.flatMap(g=>[
      prepare(`INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled)
        SELECT ?3,?1,?4,'custom','Soup','',99,1 WHERE ${gate}`,week.collection_id,token,g.id,weekday),
      prepare(`INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value)
        SELECT ?3,value,'','','','legacy',0,NULL FROM json_each('[1,2,3,4]') WHERE ${gate}`,week.collection_id,token,g.id),
    ]),
    ...rows.map(r=>prepare(`UPDATE special_slots SET content=?3,price='',origin='automation',manual_locked=0,last_auto_value=?3,manual_edited_at=NULL
      WHERE group_id=?4 AND position=?5 AND ${gate}`,week.collection_id,token,r.content,r.group_id,r.position)),
    ...(rows.length ? [prepare(`UPDATE weekly_specials SET updated_at=CURRENT_TIMESTAMP WHERE id=?3 AND ${gate}`,week.collection_id,token,week.id)] : []),
    // Evidence remains staged and reusable even after a partial publication.
    ...dailySources.map(s=>prepare(`INSERT INTO special_import_events(import_id,event_type,detail) SELECT ?3,'review',?4 WHERE ${gate}`,week.collection_id,token,s.id,detail)),
    ...(conflictDetail ? dailySources.map(s=>prepare(`INSERT INTO special_import_events(import_id,event_type,detail) SELECT ?3,'review',?4 WHERE ${gate}`,week.collection_id,token,s.id,conflictDetail)) : []),
    prepare('SELECT id FROM special_collections WHERE id=?1 AND mutation_token=?2',week.collection_id,token),
  ]);
  return results.at(-1)?.results?.length ? withOutcome({written:rows.length>0,reason:detail,blocked,rejectedSources},week.revision+1) : stage('Concurrent change; nothing written');
}

function chicagoYearOf(isoString) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(isoString));
    return Number(Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value])).year);
  } catch { return null; }
}

async function resolveWeeklyLunchTargetWeek(env, evidence, fbCreatedTime, today) {
  if (evidence.date_range) {
    const m = evidence.date_range.match(/^(\d{1,2})\/(\d{1,2})-(\d{1,2})\/(\d{1,2})$/);
    if (!m) return null;
    const startMonth = Number(m[1]).toString().padStart(2, '0');
    const startDay = Number(m[2]).toString().padStart(2, '0');
    const baseYear = chicagoYearOf(fbCreatedTime);
    if (!baseYear) return null;
    for (const year of [baseYear, baseYear + 1]) {
      const weekStart = `${year}-${startMonth}-${startDay}`;
      const {results} = await env.DB.prepare(`SELECT w.id,w.week_start_date,c.id collection_id,c.revision FROM weekly_specials w
        LEFT JOIN special_collections c ON c.weekly_special_id=w.id AND c.kind='week'
        WHERE w.week_start_date=?1`).bind(weekStart).all();
      if (results.length === 1 && results[0].collection_id != null) {
        if(env.SPECIALS_EVIDENCE_VERSION==='2') {
          const start=new Date(`${weekStart}T12:00:00Z`);
          const end=new Date(start);end.setUTCDate(end.getUTCDate()+4);
          if(start.getUTCDay()!==1 || end.getUTCMonth()+1!==+m[3] || end.getUTCDate()!==+m[4]) return null;
        }
        return results[0];
      }
    }
    return null;
  }
  // In contract 2 an undated source belongs to its creation week, not to a
  // future week that a later reconciliation happens to be visiting.
  const sourceDay=env.SPECIALS_EVIDENCE_VERSION==='2'
    ? new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(fbCreatedTime)) : today;
  const {results} = await env.DB.prepare(`SELECT w.id,w.week_start_date,c.id collection_id,c.revision FROM weekly_specials w
    LEFT JOIN special_collections c ON c.weekly_special_id=w.id AND c.kind='week'
    WHERE w.week_start_date<=?1 AND w.week_end_date>=?1`).bind(sourceDay).all();
  if (results.length !== 1 || !results[0].collection_id) return null;
  return results[0];
}

// replaceable: weekday -> slot values written by an older, no-longer-current
// weekly poster for this week; only a current replacement poster receives it.
// protectedDays: weekdays owned by a current daily poster (never overwritten).
async function applyWeeklyLunch(env, source, evidence, week, today,dependencies=[source],{inspectOnly=false,replaceable=null,protectedDays=new Set(),postedMs=NaN}={}) {
  const stage = reason => ({written: false, reason});
  const {results: groups} = await env.DB.prepare(
    'SELECT * FROM special_groups WHERE collection_id=?1 AND day_of_week IN (1,2,3,4,5)'
  ).bind(week.collection_id).all();
  const {results: slots} = await env.DB.prepare(
    `SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id
     WHERE g.collection_id=?1 AND g.day_of_week IN (1,2,3,4,5) ORDER BY s.position`
  ).bind(week.collection_id).all();

  const rows = [];
  // Read-only alert classification per held day: fixed codes, never content.
  const held = [];
  const hold = (entry, reason) => held.push({day: entry.day_of_week, reason});
  for (const entry of evidence.entries) {
    const date = new Date(`${week.week_start_date}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate()+entry.day_of_week-1);
    if (date.toISOString().slice(0,10)<today) continue;
    const lunchGroups = groups.filter(g => g.service === 'lunch' && g.day_of_week === entry.day_of_week && g.enabled === 1);
    if (lunchGroups.length !== 1) {
      const all = groups.filter(g => g.service === 'lunch' && g.day_of_week === entry.day_of_week);
      hold(entry, all.length === 1 && all[0].enabled === 0 ? 'disabled' : 'missing_destination');
      continue;
    }
    const dest = lunchGroups[0];
    const slot = slots.find(s => s.group_id === dest.id && s.position === 1);
    if (!slot) { hold(entry, 'missing_destination'); continue; }
    const canonicalContent = canonicalizeSlotContent(entry.content, entry.day_of_week, 'lunch');
    // An untouched automation value is the same poster row read without its
    // shared heading price; adding that price is the only permitted upgrade.
    const priceUpgrade = typeof entry.base_content === 'string' && slot.origin === 'automation' && slot.manual_locked === 0
      && slot.content === slot.last_auto_value && canonicalizeSlotContent(slot.content, entry.day_of_week, 'lunch') === canonicalizeSlotContent(entry.base_content, entry.day_of_week, 'lunch');
    // Fill blanks or replace untouched recurring defaults. Preserve existing
    // Facebook evidence (including the more specific daily poster) and staff edits.
    if (slot.content !== '' && slot.content !== null && !(slot.origin === 'manual' && slot.manual_locked === 0) && !priceUpgrade) {
      // Only verified automation provenance (unlocked, unchanged since the last
      // automated write, no separate price/link) can prove publication or a
      // retained Facebook value; any other filled slot is ineligible.
      const automated = slot.origin === 'automation' && slot.manual_locked === 0 && slot.last_auto_value === slot.content
        && slot.price === '' && slot.section_link === '';
      // A corrected poster replaces an unchanged automation value that an older,
      // deleted/superseded weekly poster wrote. A daily poster's value, a staff
      // edit/lock or any value of unknown provenance is never replaced.
      if (automated && slot.content !== canonicalContent && !protectedDays.has(entry.day_of_week)
          && replaceable?.get(entry.day_of_week)?.has(canonicalizeSlotContent(slot.content, entry.day_of_week, 'lunch'))) {
        // The newest poster controls, even without a price; staff are notified.
        rows.push({group_id: dest.id, position: 1, content: canonicalContent, old: slot, replaced: true,
          priceRemoved: hasPrintedPrice(slot.content) && !hasPrintedPrice(canonicalContent)});
        continue;
      }
      hold(entry, slot.manual_locked === 1 ? 'staff_locked' : !automated ? 'ineligible'
        : slot.content === canonicalContent ? 'published' : 'retained');
      continue;
    }
    if (!replaceableSlot(slot, postedMs)) {
      // A blank slot whose last automation value differs was cleared by staff.
      hold(entry, slot.manual_locked === 1 ? 'staff_locked' : !newerThanStaffEdit(slot, postedMs) ? 'staff_edit_newer'
        : (slot.content === '' || slot.content === null) && typeof slot.last_auto_value === 'string' ? 'staff_cleared' : 'ineligible');
      continue;
    }
    if (slot.origin === 'automation' && slot.content === canonicalContent && slot.last_auto_value === canonicalContent) { hold(entry, 'published'); continue; }
    // A staff edit carrying a price, replaced by an unpriced newer poster, is reported too.
    rows.push({group_id: dest.id, position: 1, content: canonicalContent, old: slot,
      priceRemoved: !!slot.manual_edited_at && hasPrintedPrice(slot.content ?? '') && !hasPrintedPrice(canonicalContent)});
  }
  if (inspectOnly) return {written: false, requiresWrite: rows.length > 0, pendingDays: rows.map(r => groups.find(g => g.id === r.group_id).day_of_week), held,
    reason: rows.length ? 'Eligible weekly lunch changes remain unwritten' : 'No unambiguous eligible weekly lunch changes'};
  if (!rows.length) return stage('No unambiguous eligible weekly lunch changes');

  const token = crypto.randomUUID();
  const prepare = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const dateRangeLabel = evidence.date_range ?? 'no date range';
  const claim = prepare(`UPDATE special_collections SET revision=revision+1,mutation_token=?1
    WHERE id=?2 AND revision=?3 AND kind='week' AND weekly_special_id=?4
    AND EXISTS(SELECT 1 FROM special_migration_checks WHERE version=15 AND mismatches=0)
    AND (SELECT count(*) FROM weekly_specials WHERE id=?4)=1
    AND EXISTS(SELECT 1 FROM weekly_specials WHERE id=?4 AND week_start_date=?8)
    AND (SELECT count(*) FROM special_groups WHERE collection_id=?2 AND day_of_week IN (1,2,3,4,5))=json_array_length(?5)
    AND NOT EXISTS(SELECT 1 FROM json_each(?5) j WHERE NOT EXISTS(SELECT 1 FROM special_groups g
      WHERE g.id=json_extract(j.value,'$.id') AND g.collection_id=?2 AND g.day_of_week=json_extract(j.value,'$.day_of_week')
      AND g.service=json_extract(j.value,'$.service') AND g.enabled=json_extract(j.value,'$.enabled')))
    AND (SELECT count(*) FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id=?2 AND g.day_of_week IN (1,2,3,4,5))=json_array_length(?6)
    AND NOT EXISTS(SELECT 1 FROM json_each(?6) j WHERE NOT EXISTS(SELECT 1 FROM special_slots s
      WHERE s.group_id=json_extract(j.value,'$.group_id') AND s.position=json_extract(j.value,'$.position')
      AND s.content IS json_extract(j.value,'$.content') AND s.price=json_extract(j.value,'$.price')
      AND s.section_link=json_extract(j.value,'$.section_link') AND s.origin=json_extract(j.value,'$.origin')
      AND s.manual_locked=json_extract(j.value,'$.manual_locked') AND s.last_auto_value IS json_extract(j.value,'$.last_auto_value')))
    AND NOT EXISTS(SELECT 1 FROM json_each(?7) j WHERE NOT EXISTS(SELECT 1 FROM special_imports i
      WHERE i.id=json_extract(j.value,'$.id') AND i.candidate_json=json_extract(j.value,'$.candidate_json')
      AND i.fb_created_time IS json_extract(j.value,'$.fb_created_time')
      AND i.processing_status='staged' AND i.validation_result='ok' AND i.review_status=json_extract(j.value,'$.review_status')
      AND i.image_r2_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM special_imports newer
        WHERE newer.fb_post_id=i.fb_post_id AND newer.parser_version=i.parser_version AND newer.rowid>i.rowid)))`,
    token, week.collection_id, week.revision, week.id,
    JSON.stringify(groups), JSON.stringify(slots), JSON.stringify(dependencies),week.week_start_date);

  const gate = 'EXISTS(SELECT 1 FROM special_collections WHERE id=?1 AND mutation_token=?2)';
  const replacedCount = rows.filter(r => r.replaced).length;
  const removedDays = rows.filter(r => r.priceRemoved).map(r => groups.find(g => g.id === r.group_id).day_of_week);
  const detail = `GUARDED_WEEKLY_LUNCH: ${dateRangeLabel}; ${rows.length} slot(s)${replacedCount ? `; replaced ${replacedCount} superseded poster value(s)` : ''}${removedDays.length ? `; price removed: ${removedDays.join(',')}` : ''}`;
  const results = await env.DB.batch([
    claim,
    ...rows.map(r => prepare(`UPDATE special_slots SET content=?3,price='',origin='automation',manual_locked=0,last_auto_value=?3,manual_edited_at=NULL
      WHERE group_id=?4 AND position=?5 AND ${gate}`, week.collection_id, token, r.content, r.group_id, r.position)),
    prepare(`UPDATE weekly_specials SET updated_at=CURRENT_TIMESTAMP WHERE id=?3 AND ${gate}`, week.collection_id, token, week.id),
    prepare(`INSERT INTO special_import_events(import_id,event_type,detail) SELECT ?3,'review',?4 WHERE ${gate}`, week.collection_id, token, source.id, detail),
    prepare('SELECT id FROM special_collections WHERE id=?1 AND mutation_token=?2', week.collection_id, token),
  ]);
  return results.at(-1)?.results?.length ? {written: true, reason: detail} : stage('Concurrent change; nothing written');
}

const chicagoDayOf = time => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
// The weekday a daily poster's offers belong to. An undated poster (-1) belongs
// to its verified Facebook creation day, and only when it lists offers.
export function dailyPosterWeekday(candidate, createdTime, today) {
  if(!('offers' in candidate) || !Number.isInteger(candidate.day_of_week)) return null;
  if(candidate.day_of_week!==-1) return candidate.day_of_week;
  if(!candidate.offers?.length || !Number.isFinite(Date.parse(createdTime)) || chicagoDayOf(createdTime)!==today) return null;
  return new Date(`${today}T12:00:00Z`).getUTCDay();
}
const weeklyEvidence = raw => applySharedWeeklyLunchPrice({...validateWeeklyLunch(normalizeWeeklyRange(raw)),unresolved_days:raw.unresolved_days??[]});

// Slot values that earlier weekly posters actually wrote for this week (audited
// GUARDED_WEEKLY_LUNCH writes), by weekday. Used only as replacement provenance.
async function priorWeeklyWriters(env, week, today) {
  const {results} = await env.DB.prepare(`SELECT i.id,i.fb_created_time,i.candidate_json FROM special_imports i
    WHERE i.candidate_json LIKE ?1 AND EXISTS(SELECT 1 FROM special_import_events e
      WHERE e.import_id=i.id AND e.event_type='review' AND e.detail LIKE 'GUARDED_WEEKLY_LUNCH:%')`).bind('{"type":"weekly-lunch"%').all();
  const writers = [];
  for (const row of results) {
    try {
      const evidence = weeklyEvidence(JSON.parse(row.candidate_json));
      const target = await resolveWeeklyLunchTargetWeek(env, evidence, row.fb_created_time, today);
      if (target?.id !== week.id) continue;
      const byDay = new Map();
      for (const e of evidence.entries) for (const value of [e.content, e.base_content].filter(v => typeof v === 'string'))
        byDay.set(e.day_of_week, (byDay.get(e.day_of_week) ?? new Set()).add(canonicalizeSlotContent(value, e.day_of_week, 'lunch')));
      writers.push({id: row.id, created: Date.parse(row.fb_created_time), byDay});
    } catch { /* Unusable history never authorizes a replacement. */ }
  }
  return writers;
}

// sourceIds is the import set of a COMPLETE Facebook Page scan (today only).
// With it: a weekly import created today but absent from that scan was deleted
// (or replaced) and is never used; a current poster supersedes older posters for
// its week; only current posters may replace older weekly automation values.
// Without it (no complete scan), legacy fill-only behavior applies.
// inspectOnly is the alert's read-only view: limited to the fenced scan sources,
// it reports per-source holds with fixed codes and never writes.
export async function reconcileWeeklyLunch(env, today, {sourceIds=null, inspectOnly=false}={}) {
  const current = Array.isArray(sourceIds) ? new Set(sourceIds) : null;
  const {results: staged} = await env.DB.prepare(
    `SELECT * FROM special_imports WHERE parser_version=?1 AND processing_status='staged' AND validation_result='ok'
     AND image_r2_key IS NOT NULL AND review_status IN ('pending','accepted')
     AND candidate_json LIKE ?2
     AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=special_imports.fb_post_id
       AND newer.parser_version=?1 AND newer.rowid>special_imports.rowid)`
  ).bind(parserVersionFor(env), '{"type":"weekly-lunch"%').all();
  const sources = staged.filter(s => {
    if (!current || current.has(s.id)) return true;
    if (inspectOnly) return false;
    // Created today yet absent from the complete scan: deleted or replaced.
    return Number.isFinite(Date.parse(s.fb_created_time)) && chicagoDayOf(s.fb_created_time) !== today;
  });
  if (!sources.length) return inspectOnly ? [] : {written: false, reason: 'No weekly lunch sources'};
  if(env.SPECIALS_EVIDENCE_VERSION==='2') {
    let plans=[];const unusable=[];
    for(const source of sources) {
      try {
        if(!Number.isFinite(Date.parse(source.fb_created_time)) || Date.parse(source.fb_created_time)>Date.now()) continue;
        const evidence=weeklyEvidence(JSON.parse(source.candidate_json));
        const week=await resolveWeeklyLunchTargetWeek(env,evidence,source.fb_created_time,today);
        if(week) plans.push({source,evidence,week});
        else unusable.push({sourceId:source.id,reason:'no_matching_week',dateRange:evidence.date_range});
      } catch { unusable.push({sourceId:source.id,reason:'invalid_evidence'}); /* Unusable weekly scope cannot be rebound to an unrelated week. */ }
    }
    // Newer wins: an older poster (outside today's scan) never competes with a
    // current poster for the same week; current posters still conflict normally.
    const protectedDays=new Set(),writersByWeek=new Map();
    if(current) {
      const currentWeeks=new Set(plans.filter(p=>current.has(p.source.id)).map(p=>p.week.id));
      plans=plans.filter(p=>current.has(p.source.id) || !currentWeeks.has(p.week.id));
      const {results:daily}=await env.DB.prepare(`SELECT candidate_json,fb_created_time FROM special_imports WHERE id IN (SELECT value FROM json_each(?1))
        AND processing_status='staged' AND validation_result='ok' AND review_status IN ('pending','accepted')`).bind(JSON.stringify([...current])).all();
      for(const row of daily) {
        try { const day=dailyPosterWeekday(JSON.parse(row.candidate_json),row.fb_created_time,today); if(day!==null) protectedDays.add(day); } catch { /* not daily */ }
      }
      for(const week of new Map(plans.filter(p=>current.has(p.source.id)).map(p=>[p.week.id,p.week])).values())
        writersByWeek.set(week.id,await priorWeeklyWriters(env,week,today));
    }
    const replaceableFor=plan=>{
      if(!current?.has(plan.source.id)) return null;
      const created=postTimes.get(plan.source.id),map=new Map();
      for(const w of writersByWeek.get(plan.week.id)??[]) {
        // A poster still up can be replaced too, but only by one verified as newer.
        if(w.id===plan.source.id || !(w.created<=created) || (current.has(w.id) && !(w.created<created))) continue;
        for(const [day,values] of w.byDay) map.set(day,new Set([...(map.get(day)??[]),...values]));
      }
      return map;
    };
    const results=inspectOnly?[...unusable]:[];
    const postTimes=await verifiedPostTimes(env,plans.map(p=>p.source));
    for(const plan of plans) {
      const peers=plans.filter(p=>p.week.id===plan.week.id);
      // Per weekday, a poster verified as newer with a meal for that day supersedes
      // older ones. Equal or unknown times prove nothing, so those posters still conflict.
      const superseded=(p,day)=>peers.some(q=>postTimes.get(q.source.id)>postTimes.get(p.source.id) && q.evidence.entries.some(e=>e.day_of_week===day));
      const conflicts=[];
      const entries=plan.evidence.entries.filter(entry=>{
        const day=entry.day_of_week;
        if(superseded(plan,day)) return false;
        const rivals=peers.filter(p=>!superseded(p,day));
        const unresolved=rivals.some(p=>p.evidence.unresolved_days.some(d=>d.day===day));
        const agreed=new Set(rivals.flatMap(p=>p.evidence.entries.filter(e=>e.day_of_week===day).map(e=>factKey(e.content)))).size===1;
        if(!unresolved && !agreed) conflicts.push(day);
        return !unresolved && agreed;
      });
      if(inspectOnly) {
        const outcome=await applyWeeklyLunch(env,plan.source,{...plan.evidence,entries},plan.week,today,peers.map(p=>p.source),
          {inspectOnly:true,replaceable:replaceableFor(plan),protectedDays,postedMs:postTimes.get(plan.source.id)});
        results.push({...outcome,sourceId:plan.source.id,weekId:plan.week.id,weekStart:plan.week.week_start_date,dateRange:plan.evidence.date_range,
          entries:plan.evidence.entries.map(e=>({day:e.day_of_week,key:factKey(e.base_content??e.content)})),
          unresolvedDays:plan.evidence.unresolved_days.filter(d=>!superseded(plan,d.day)).map(d=>({day:d.day,reason:d.reason})),conflictDays:conflicts,
          // An all-unpriced weekly poster is normal; an unpriced row beside priced ones is reported.
          unpricedDays:entries.some(e=>hasPrintedPrice(e.content))?entries.filter(e=>!hasPrintedPrice(e.content)).map(e=>e.day_of_week):[]});
        continue;
      }
      results.push(await applyWeeklyLunch(env,plan.source,{...plan.evidence,entries},plan.week,today,peers.map(p=>p.source),
        {replaceable:replaceableFor(plan),protectedDays,postedMs:postTimes.get(plan.source.id)}));
      // Each apply snapshots the current collection revision; reread before a
      // subsequent independent source to avoid using a stale plan revision.
      for(const next of plans) if(next.week.id===plan.week.id) {
        const row=await env.DB.prepare('SELECT revision FROM special_collections WHERE id=?1').bind(next.week.collection_id).first();
        if(row) next.week.revision=row.revision;
      }
    }
    return results;
  }
  const perSource = [];
  for (const source of sources) {
    let evidence;
    try { evidence = applySharedWeeklyLunchPrice(validateWeeklyLunch(JSON.parse(source.candidate_json))); }
    catch { perSource.push({written: false, reason: 'Invalid evidence'}); continue; }
    const week = await resolveWeeklyLunchTargetWeek(env, evidence, source.fb_created_time, today);
    if (!week) { perSource.push({written: false, reason: 'No matching saved week'}); continue; }
    const result = await applyWeeklyLunch(env, source, evidence, week, today);
    perSource.push(result);
  }
  return perSource;
}

async function applyMexicanNight(env, source, evidence, weekStart) {
  const stage = reason => ({written: false, reason});
  const collection = await env.DB.prepare(
    "SELECT * FROM special_collections WHERE id='mexican-night' AND kind='section'"
  ).first();
  if (!collection) return stage('Mexican Night collection not found');
  const {results: currentGroups} = await env.DB.prepare(
    "SELECT * FROM special_groups WHERE collection_id='mexican-night' ORDER BY sort,id"
  ).all();
  const {results: currentSlots} = await env.DB.prepare(
    `SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id
     WHERE g.collection_id='mexican-night' ORDER BY g.sort,g.id,s.position`
  ).all();
  const defaults = await env.DB.prepare("SELECT * FROM special_collections WHERE id='mexican-night-defaults'").first();
  const {results: defaultGroups} = await env.DB.prepare("SELECT * FROM special_groups WHERE collection_id='mexican-night-defaults' ORDER BY sort,id").all();
  const {results: defaultSlots} = await env.DB.prepare("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night-defaults' ORDER BY g.sort,g.id,s.position").all();
  const schedule=defaults?.schedule || 'Tuesdays · 5 – 10 PM';
  if(evidence.schedule && (!scheduleKey(evidence.schedule) || scheduleKey(evidence.schedule)!==scheduleKey(schedule))) {
    const reason=`REVIEW_REQUIRED_MEXICAN_SCHEDULE: printed ${evidence.schedule}; recurring ${schedule}`;
    await env.DB.batch([
      env.DB.prepare("UPDATE special_imports SET review_reason=?2 WHERE id=?1 AND review_status='pending'").bind(source.id,reason),
      env.DB.prepare("INSERT INTO special_import_events(import_id,event_type,detail) SELECT ?1,'review',?2 WHERE NOT EXISTS(SELECT 1 FROM special_import_events WHERE import_id=?1 AND detail=?2)").bind(source.id,reason),
    ]);
    return stage(reason);
  }
  const storedCurrent=storedMexicanGroups(currentGroups,currentSlots);
  let groups;
  try {
    const recurring=storedMexicanGroups(defaultGroups,defaultSlots);
    const current=collection.section_week_start===weekStart || !collection.section_week_start
      ? storedMexicanGroups(currentGroups,currentSlots) : [];
    // Normalize newly published groups. A completely retained group stays byte
    // for byte intact, including split prices, blank slots and ownership. The
    // reviewed backfill handles its existing casing without rebuilding it.
    groups=mergeMexicanMenu(evidence.groups,mergeMexicanMenu(current,recurring)).map(g=>
      storedCurrent.some(old=>old.id===g.id && old.label===g.label && JSON.stringify(old.items)===JSON.stringify(g.items)) ? g
        : {...g,label:normalizeMenuCase(g.label),items:g.items.map(item=>({...item,title:normalizeMenuCase(item.title),description:normalizeMenuCase(item.description)}))});
  } catch(error) { return stage(error.message); }
  const token = crypto.randomUUID();
  const prepare = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const gate = "EXISTS(SELECT 1 FROM special_collections WHERE id='mexican-night' AND mutation_token=?1)";
  const sourcePrefix = source.id.slice(0, 8);
  const retainedIds=groups.filter(g=>g.id && storedCurrent.some(old=>old.id===g.id && old.label===g.label && JSON.stringify(old.items)===JSON.stringify(g.items))).map(g=>g.id);
  const newGroupRows = groups.map((g, i) => [currentGroups.some(old=>old.id===g.id) ? g.id : `mn:${sourcePrefix}:${i}`, g.label, i]);
  const newSlotRows = groups.flatMap((g, i) => g.items.map((item, j) => {
    const price = accessoryGroup(g.label) ? normalizeMexicanPrices : text => text;
    return [newGroupRows[i][0], j + 1, composeMexicanItem(price(item.title), price(item.description))];
  }));
  const detail = `GUARDED_MEXICAN_NIGHT: fb_created=${source.fb_created_time}; ${groups.length} group(s); ${newSlotRows.length} item(s)`;
  const results = await env.DB.batch([
    prepare(`UPDATE special_collections SET revision=revision+1,mutation_token=?1,title=?2,schedule=?3,updated_at=?13,
      section_week_start=?12,section_service_date=date(?12,'+1 day'),section_source='facebook'
      WHERE id='mexican-night' AND kind='section' AND revision=?4
      AND COALESCE(section_source,'')<>'manual' AND NOT ${protectedMexicanSlots}
      AND (SELECT revision FROM special_collections WHERE id='mexican-night-defaults') IS ?14
      AND (SELECT count(*) FROM special_groups WHERE collection_id='mexican-night-defaults')=json_array_length(?15)
      AND NOT EXISTS(SELECT 1 FROM json_each(?15) j WHERE NOT EXISTS(SELECT 1 FROM special_groups g WHERE g.id=json_extract(j.value,'$.id') AND g.label=json_extract(j.value,'$.label') AND g.enabled=json_extract(j.value,'$.enabled') AND g.sort=json_extract(j.value,'$.sort')))
      AND (SELECT count(*) FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night-defaults')=json_array_length(?16)
      AND NOT EXISTS(SELECT 1 FROM json_each(?16) j WHERE NOT EXISTS(SELECT 1 FROM special_slots s WHERE s.group_id=json_extract(j.value,'$.group_id') AND s.position=json_extract(j.value,'$.position') AND s.content IS json_extract(j.value,'$.content') AND s.price=json_extract(j.value,'$.price')))
      AND (section_week_start IS NULL OR section_week_start<=?12)
      AND EXISTS(SELECT 1 FROM special_migration_checks WHERE version=15 AND mismatches=0)
      AND (SELECT count(*) FROM special_groups WHERE collection_id='mexican-night')=?5
      AND NOT EXISTS(SELECT 1 FROM json_each(?6) j WHERE NOT EXISTS(SELECT 1 FROM special_groups g
        WHERE g.id=json_extract(j.value,'$.id') AND g.collection_id='mexican-night'
        AND g.label=json_extract(j.value,'$.label') AND g.sort=json_extract(j.value,'$.sort')
        AND g.enabled=json_extract(j.value,'$.enabled')))
      AND (SELECT count(*) FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night')=?7
      AND NOT EXISTS(SELECT 1 FROM json_each(?8) j WHERE NOT EXISTS(SELECT 1 FROM special_slots s
        WHERE s.group_id=json_extract(j.value,'$.group_id') AND s.position=json_extract(j.value,'$.position')
        AND s.content IS json_extract(j.value,'$.content') AND s.origin=json_extract(j.value,'$.origin')
        AND s.manual_locked=json_extract(j.value,'$.manual_locked')
        AND s.price=json_extract(j.value,'$.price') AND s.section_link=json_extract(j.value,'$.section_link')
        AND s.last_auto_value IS json_extract(j.value,'$.last_auto_value')))
      AND EXISTS(SELECT 1 FROM special_imports WHERE id=?9 AND candidate_json=?10
        AND processing_status='staged' AND validation_result='ok' AND image_r2_key IS NOT NULL
        AND review_status IN ('pending','accepted')
        AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=special_imports.fb_post_id
          AND newer.parser_version=?11 AND newer.rowid>special_imports.rowid))`,
      token, 'Mexican Night', schedule, collection.revision,
      currentGroups.length, JSON.stringify(currentGroups),
      currentSlots.length, JSON.stringify(currentSlots),
      source.id, source.candidate_json, parserVersionFor(env), weekStart, new Date(Date.now()).toISOString(), defaults?.revision ?? null, JSON.stringify(defaultGroups), JSON.stringify(defaultSlots)),
    prepare(`DELETE FROM special_groups WHERE collection_id='mexican-night' AND id NOT IN (SELECT value FROM json_each(?2)) AND ${gate}`, token, JSON.stringify(retainedIds)),
    prepare(`INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled)
      SELECT json_extract(value,'$[0]'),'mexican-night',-1,'custom',json_extract(value,'$[1]'),'',json_extract(value,'$[2]'),1
      FROM json_each(?2) WHERE ${gate}`, token, JSON.stringify(newGroupRows.filter(row=>!retainedIds.includes(row[0])))),
    prepare(`INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value)
      SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),'','','automation',0,json_extract(value,'$[2]')
      FROM json_each(?2) WHERE ${gate}`, token, JSON.stringify(newSlotRows.filter(row=>!retainedIds.includes(row[0])))),
    prepare(`INSERT INTO special_import_events(import_id,event_type,detail) SELECT ?2,'review',?3 WHERE ${gate}`,
      token, source.id, detail),
    prepare(`SELECT id FROM special_collections WHERE id='mexican-night' AND mutation_token=?1`, token),
  ]);
  return results.at(-1)?.results?.length ? {written: true, reason: detail} : stage('Concurrent change; nothing written');
}

export async function reconcileMexicanNight(env) {
  const {results: sources} = await env.DB.prepare(
    `SELECT * FROM special_imports WHERE parser_version=?1 AND processing_status='staged' AND validation_result='ok'
     AND image_r2_key IS NOT NULL AND review_status IN ('pending','accepted')
     AND target_collection_id='mexican-night'
     AND candidate_json LIKE ?2
     AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=special_imports.fb_post_id
       AND newer.parser_version=?1 AND newer.rowid>special_imports.rowid)
     AND NOT EXISTS(SELECT 1 FROM special_import_events WHERE import_id=special_imports.id AND event_type='review')
     ORDER BY fb_created_time DESC`
  ).bind(parserVersionFor(env), '{"type":"mexican-night"%').all();
  if (!sources.length) return {written: false, reason: 'No new Mexican Night source'};
  const dateOf=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
  const today=dateOf(Date.now());
  const source=sources.find(s=>Number.isFinite(Date.parse(s.fb_created_time)) && dateOf(s.fb_created_time)===today);
  if (!source) return {written:false,reason:'No current-day Mexican Night source'};
  const weekday=new Date(`${today}T12:00:00Z`).getUTCDay();
  const {start}=automaticWeekRange(today,weekday,weekday===0 ? 19 : 0);
  let evidence;
  try { evidence = validateMexicanNight(JSON.parse(source.candidate_json)); }
  catch { return {written: false, reason: 'Invalid Mexican Night evidence'}; }
  return applyMexicanNight(env, source, evidence, start);
}

export async function pruneImportHistory(env, now) {
  // Migration 0017 has ON DELETE CASCADE; explicit event deletion also works
  // with FK enforcement enabled. No specials table is part of this cleanup.
  const cutoff = new Date(now.getTime() - 30*24*60*60*1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM special_import_events WHERE import_id IN
      (SELECT id FROM special_imports WHERE julianday(fetched_at)<julianday(?1))`).bind(cutoff),
    env.DB.prepare('DELETE FROM special_imports WHERE julianday(fetched_at)<julianday(?1)').bind(cutoff),
  ]);
}
