import {parserVersionFor,classifyCaption} from './classify.js';
import {reconcileToday,reconcileWeeklyLunch,dailyPosterWeekday} from './guarded-auto.js';
import {hasPrintedPrice} from './evidence.js';
import {reconcileDelivery} from './delivery.js';
import {validateCurrentDay,hasWeeklyLunchEvidence,singleDayLunchEvidence,singleDayLunchEvidenceV2,canonicalizeSlotContent,WEEKLY_LUNCH_SHAPE_ERROR} from './reconcile.js';
import {factKey} from './evidence.js';
import {deliveryWindow,resolveDeliveryDisplay} from '../../src/lib/delivery.js';
import {dailyPublicationObservation,importAlertObservation} from './alert-policy.js';
import {ALERT_GRACE_MS,dispatchAlert,alertEvidenceFence} from './alert-store.js';
import {alertTransport} from './alert-email.js';
import {dailyAlertDetail,deliveryAlertDetail,weeklyAlertDetail,wingAlertDetail} from './alert-detail.js';
import {readWingAttention} from './wing-review.js';
import {isWingOffer} from './wing-night.js';

const MODES=['OBSERVE','MOCK','EMAIL'];
const FRESH_MS=90*60*1000;
// Each dispatchAlert claims, fences and sends at most one incident; a
// superseded claim keeps its lease, so the next iteration reaches another.
// Covers daily, delivery and weekly with headroom; bounded by the send timeout.
const MAX_DISPATCH_PER_RUN=6;
const hour=now=>Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',hourCycle:'h23'}).format(new Date(now)));
const active=env=>MODES.includes(env.SPECIALS_ALERT_MODE) && env.SPECIALS_IMPORT_MODE==='GUARDED_AUTO';
const safeError=()=>console.error('Facebook alert subsystem unavailable');
function canonical(value) {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(value)))))]
    .map(v=>v.toString(16).padStart(2,'0')).join('');
}

// Start BEFORE Graph fetching: incomplete/newer scans invalidate older evidence.
// Errors here are isolated from the import lifecycle and never enable dispatch.
export async function beginAlertScan(env,day,started=Date.now()) {
  if(!active(env)) return null;
  try {
    const token=crypto.randomUUID(),parser=parserVersionFor(env);
    await env.DB.prepare(`INSERT INTO facebook_alert_scans(day,token,started_ms,parser)
      VALUES(?1,?2,?3,?4) ON CONFLICT(day) DO UPDATE SET token=excluded.token,
      started_ms=excluded.started_ms,parser=excluded.parser,completed_ms=NULL,source_ids=NULL,
      evaluated_ms=NULL,evaluation_state='pending',evaluation_error=NULL
      WHERE excluded.started_ms>=facebook_alert_scans.started_ms`).bind(day,token,started,parser).run();
    return {day,token,started,parser};
  } catch {safeError();return null;}
}

// A transactional read captures sources (including newer-version detection),
// ownership, staff locks, revisions, delivery and migration guard state. Only
// its hash is persisted. Content is never copied into the outbox or telemetry.
async function snapshot(env,scan) {
  const q=(sql,...args)=>env.DB.prepare(sql).bind(...args);
  const result=await env.DB.batch([
    q(`SELECT i.*,EXISTS(SELECT 1 FROM special_imports n WHERE n.fb_post_id=i.fb_post_id
      AND n.parser_version=i.parser_version AND n.rowid>i.rowid) AS superseded
      FROM special_imports i WHERE i.id IN (SELECT value FROM json_each(?1)) ORDER BY i.id`,scan.source_ids),
    q('SELECT * FROM weekly_specials WHERE week_start_date<=?1 AND week_end_date>=?1 ORDER BY id',scan.day),
    q('SELECT * FROM special_collections ORDER BY id'),
    q('SELECT * FROM special_groups ORDER BY id'),
    q('SELECT * FROM special_slots ORDER BY group_id,position'),
    q("SELECT value FROM settings WHERE key='delivery_display'"),
    q('SELECT * FROM delivery_automation ORDER BY id'),
    q('SELECT * FROM special_migration_checks ORDER BY version'),
  ]);
  const data=result.map(r=>r.results);
  if(data[0].length!==JSON.parse(scan.source_ids).length || data[0].some(s=>s.superseded || s.parser_version!==scan.parser)) return null;
  return {data,hash:await digest(data),sourceIds:JSON.parse(scan.source_ids),day:scan.day};
}

function currentSource(s,scan,now) {
  const time=Date.parse(s.fb_created_time);
  return Number.isFinite(time) && time<=now && deliveryWindow(new Date(time)).day===scan.day;
}
function dedicated(s) {
  if(s.validation_reason===WEEKLY_LUNCH_SHAPE_ERROR) return true;
  try {
    const c=JSON.parse(s.candidate_json || s.extracted_json);
    return ['weekly-lunch','mexican-night'].includes(c?.type) && !('offers' in c) && !('day_of_week' in c);
  } catch {return s.target_kind==='section' || (s.target_kind==='week' && s.target_day==null);}
}
// Weekly Lunch has its own scope: daily publication never proves it, and the
// daily assessment above excludes these sources via dedicated().
const unfence=s=>String(s).replace(/^```(?:json)?\n?|\n?```$/gm,'').trim();
// A one-day lunch poster in the weekly shape is daily evidence (validateExtraction).
// Recognition that then fails price checks is still daily-owned.
function singleDay(c) {
  try {return !!(singleDayLunchEvidenceV2(c) || singleDayLunchEvidence(c));} catch {return true;}
}
function weeklyReading(s) {
  try {
    const c=JSON.parse(unfence(s.candidate_json || s.extracted_json));
    if(c?.type==='weekly-lunch' && !('offers' in c) && !singleDay(c)) return c;
  } catch { /* Shape is decided below without trusting malformed output. */ }
  return null;
}
function weeklySource(s) {
  if(weeklyReading(s)) return true;
  // A weekly poster read as daily offers that never recovered its weekly shape.
  if(s.validation_reason===WEEKLY_LUNCH_SHAPE_ERROR) return true;
  return !s.candidate_json && !s.extracted_json && hasWeeklyLunchEvidence(String(s.caption??''));
}
// Advertised rows of a failed reading: weekday and a comparison key only. The
// raw text is never displayed; unusable rows make coverage unprovable.
function advertised(s) {
  const entries=weeklyReading({extracted_json:s.extracted_json})?.entries;
  if(!Array.isArray(entries) || !entries.length) return null;
  const rows=entries.map(e=>Number.isInteger(e?.day_of_week) && e.day_of_week>=1 && e.day_of_week<=5
    && typeof e.content==='string' && e.content.trim() ? {day:e.day_of_week,key:factKey(e.content)} : null);
  return rows.every(Boolean)?rows:null;
}
const WEEKLY_PUBLICATION_HOLDS=new Set(['missing_destination','ineligible']);

// Same-day deduplication identity for Weekly Lunch. Equivalent posters with
// different Facebook IDs share it; a different week, weekday or meal is a new
// incident. Cause/category changes for the same meals are not. Only a digest
// is stored; meal text never enters the alert tables.
async function weeklyFingerprint(scan,sources,failures,inspection) {
  const range=v=>typeof v==='string' && /^\d{1,2}\/\d{1,2}-\d{1,2}\/\d{1,2}$/.test(v)?v:null;
  const printed=s=>{try {return range(JSON.parse(unfence(s.extracted_json))?.date_range);} catch {return null;}};
  const tokens=new Set();
  for(const f of failures) {
    const week=f.weekStart ?? range(f.dateRange) ?? printed(sources.find(s=>s.id===f.sourceId) ?? {}) ?? scan.day;
    if(f.rows) for(const r of f.rows) tokens.add(`${week}|${r.day}|${r.key}`);
    else if(Number.isInteger(f.day)) {
      // This failure's own source meal: a conflict is identified by every
      // conflicting meal (one failure per source), never the first match.
      const key=inspection.find(r=>r.sourceId===f.sourceId)?.entries?.find(e=>e.day===f.day)?.key ?? '';
      tokens.add(`${week}|${f.day}|${key}`);
    } else {
      // Unreadable or unscoped source: the image identity, never its text.
      const s=sources.find(x=>x.id===f.sourceId);
      tokens.add(`${week}|source|${s?.image_hash ?? s?.fb_post_id ?? f.reason}`);
    }
  }
  return (await digest([...tokens].sort())).slice(0,16);
}

async function assessWeekly(env,scan,snap,now,sourceIds) {
  const sources=snap.data[0].filter(s=>currentSource(s,scan,now) && ['pending','accepted'].includes(s.review_status) && weeklySource(s));
  const result=(state,cause='publication_blocked',failures=[],inspection=[])=>({state,cause,
    detail:state==='attention'?weeklyAlertDetail({day:scan.day,data:snap.data,sources,failures,inspection}):null});
  if(!sources.length) return result('suppressed');
  if(sources.some(s=>['pending','processing'].includes(s.processing_status))) return result('pending');
  // Read-only, limited to the fenced scan sources, after the real publisher ran.
  const inspection=env.SPECIALS_EVIDENCE_VERSION==='2'
    ? (await reconcileWeeklyLunch(env,scan.day,{sourceIds,inspectOnly:true})).filter(r=>sources.some(s=>s.id===r.sourceId)) : null;
  const failures=[];let unknown=false,cause=null,suppressedDays=0;
  // Daily-poster precedence requires actual publication: the weekday's lunch
  // slot in the verified snapshot (already proven automation-managed by the
  // 'retained' hold) shows one of a current staged daily poster's offers. A
  // staged daily poster alone proves nothing; anything else retained, e.g. an
  // earlier weekly reading, is an unreplaced discrepancy to review.
  const dailyOffers=new Map();
  for(const s of snap.data[0].filter(s=>currentSource(s,scan,now) && s.processing_status==='staged'
    && s.validation_result==='ok' && ['pending','accepted'].includes(s.review_status) && !weeklySource(s))) {
    try {
      const c=JSON.parse(s.candidate_json),day=dailyPosterWeekday(c,s.fb_created_time,scan.day);
      if(day===null) continue;
      for(const o of c.offers) if(typeof o?.content==='string')
        dailyOffers.set(day,(dailyOffers.get(day)??new Set()).add(canonicalizeSlotContent(o.content,day,'lunch')));
    } catch { /* Not daily evidence. */ }
  }
  const [,,collections,groups,slots]=snap.data;
  const lunchSlot=(weekId,day)=>{
    const collection=collections.find(c=>c.weekly_special_id===weekId && c.kind==='week');
    const group=groups.filter(g=>g.collection_id===collection?.id && g.day_of_week===day && g.service==='lunch' && g.enabled===1);
    return group.length===1 ? slots.find(x=>x.group_id===group[0].id && x.position===1) : null;
  };
  const dailyPublished=(weekId,day)=>{
    const slot=lunchSlot(weekId,day);
    return !!slot?.content && slot.origin==='automation' && slot.manual_locked===0 && slot.last_auto_value===slot.content
      && !!dailyOffers.get(day)?.has(slot.content);
  };
  const removedDays=new Map();
  const {results:removals}=await env.DB.prepare(`SELECT import_id,detail FROM special_import_events WHERE import_id IN (SELECT value FROM json_each(?1))
    AND event_type='review' AND detail LIKE 'GUARDED_WEEKLY_LUNCH:%; price removed: %'`).bind(JSON.stringify(sources.map(s=>s.id))).all();
  for(const e of removals) removedDays.set(e.import_id,[...new Set([...(removedDays.get(e.import_id)??[]),
    ...e.detail.slice(e.detail.lastIndexOf(': ')+2).split(',').map(Number).filter(d=>Number.isInteger(d) && d>=1 && d<=5)])]);
  for(const r of inspection??[]) {
    const own=[];
    if(r.reason==='no_matching_week') own.push({category:'publication',reason:'no_matching_week',dateRange:r.dateRange});
    else if(r.reason==='invalid_evidence') own.push({category:'validation',reason:'invalid_evidence'});
    for(const d of r.unresolvedDays??[]) own.push({category:'validation',reason:'unverified_meal',day:d.day,detail:d.reason});
    for(const day of r.conflictDays??[]) own.push({category:'publication',reason:'source_conflict',day});
    for(const day of r.pendingDays??[]) own.push({category:'publication',reason:'unwritten',day});
    for(const h of r.held??[]) {
      if(WEEKLY_PUBLICATION_HOLDS.has(h.reason)) own.push({category:'publication',reason:h.reason,day:h.day});
      else if(h.reason==='retained' && !dailyPublished(r.weekId,h.day)) own.push({category:'publication',reason:'retained_conflict',day:h.day});
      else if(h.reason!=='published') suppressedDays++;
    }
    // The published replacement stays unpriced: tell staff. A later price or staff edit ends this.
    for(const day of removedDays.get(r.sourceId)??[]) {
      const slot=lunchSlot(r.weekId,day);
      if(slot?.origin==='automation' && slot.content && !hasPrintedPrice(slot.content)) own.push({category:'publication',reason:'price_removed',day});
    }
    for(const day of r.unpricedDays??[]) {
      const slot=lunchSlot(r.weekId,day);
      if(!removedDays.get(r.sourceId)?.includes(day) && slot?.origin==='automation' && slot.content && !hasPrintedPrice(slot.content)) own.push({category:'publication',reason:'published_unpriced',day});
    }
    failures.push(...own.map(f=>({...f,sourceId:r.sourceId,weekStart:r.weekStart,weekId:r.weekId,dateRange:f.dateRange??r.dateRange})));
  }
  for(const s of sources) {
    if(s.processing_status==='staged' && s.validation_result==='ok') {
      if(!inspection?.some(r=>r.sourceId===s.id)) unknown=true;
      continue;
    }
    const observed=importAlertObservation(s,{eligible:true,resolution:'unresolved'});
    if(observed.state!=='attention') {unknown=true;continue;}
    // An equivalent poster (different Facebook ID) resolves this failure only
    // when every advertised weekday shows that same meal, verified as published.
    // Staff-locked, disabled, retained or skipped days are never proof.
    const rows=advertised(s);
    const covered=rows && rows.every(a=>(inspection??[]).some(r=>r.entries?.some(e=>e.day===a.day && e.key===a.key)
      && r.held?.some(h=>h.day===a.day && h.reason==='published')));
    if(covered) continue;
    cause??=observed.code;
    failures.push({category:['ai_budget_exhausted','retry_exhausted','import_failed'].includes(observed.code)?'extraction':'validation',
      reason:observed.code,days:rows?.map(r=>r.day)??[],rows,sourceId:s.id});
  }
  if(failures.length) {
    const r=result('attention',cause??(failures.some(f=>f.category==='validation')?'validation_rejected':'publication_blocked'),failures,inspection??[]);
    return {...r,fingerprint:await weeklyFingerprint(scan,sources,failures,inspection??[])};
  }
  if(unknown) return result('pending');
  // Resolved only when every held weekday is verified published; staff
  // protection or daily precedence is an explicit suppressed outcome.
  return result(suppressedDays ? 'suppressed' : 'resolved');
}

// Wing Wednesday: only a post from today's scan that still needs staff (the same
// decision the review page shows). No poster, protected values and blanks never get here.
async function assessWing(env,scan,snap,now) {
  const outcome=(state,extra={})=>({state,cause:'wing_wednesday_failed',detail:null,...extra});
  const sources=snap.data[0].filter(s=>currentSource(s,scan,now) && ['pending','accepted'].includes(s.review_status));
  if(!sources.length) return outcome('suppressed');
  if(sources.some(s=>['pending','processing'].includes(s.processing_status))) return outcome('pending');
  const held=await readWingAttention(env);
  const source=held && sources.find(s=>s.id===held.import_id);
  if(!source) return outcome('resolved');
  let offers=[];
  try {offers=JSON.parse(unfence(source.candidate_json ?? source.extracted_json))?.offers?.filter(isWingOffer) ?? [];} catch { /* Text is only for display and identity. */ }
  // A reposted poster with the same reading is the same incident, not a new one.
  const identity=offers.length ? offers.map(o=>factKey(String(o.content))) : [source.image_hash ?? source.fb_post_id];
  const proposed=offers.map(o=>String(o.content));
  return outcome('attention',{reason:held.detail,proposed,fingerprint:(await digest([held.detail,identity])).slice(0,16),
    detail:wingAlertDetail({day:scan.day,source,reason:held.detail,proposed})});
}

function intentional(s,data,weekday) {
  const [,weeks,collections,groups,slots]=data;
  if(weeks.length!==1 || !s.target_service) return false;
  const collection=collections.find(c=>c.weekly_special_id===weeks[0].id && c.kind==='week');
  const destinations=groups.filter(g=>g.collection_id===collection?.id && g.day_of_week===weekday && g.service===s.target_service);
  return destinations.length===1 && (destinations[0].enabled===0 || slots.some(p=>p.group_id===destinations[0].id && p.manual_locked===1 && p.content));
}

function staffProtectionOnly(daily,data,day,weekday) {
  const blocked=Array.isArray(daily?.blocked)?daily.blocked:[];
  const detail=blocked.length && !daily.rejectedSources?.length ? dailyAlertDetail(daily,data,day,weekday) : null;
  return !!detail && detail.protectedCount===blocked.length;
}

async function assess(env,scan,snap) {
  const now=Date.now(),w=deliveryWindow(new Date(now)),sourceIds=JSON.parse(scan.source_ids);
  const sources=snap.data[0].filter(s=>currentSource(s,scan,now));
  const eligible=sources.filter(s=>['pending','accepted'].includes(s.review_status));
  const daily=await reconcileToday(env,{sourceIds,today:scan.day,weekday:w.weekday,inspectOnly:true});
  let food=dailyPublicationObservation(daily),cause='publication_blocked';
  // Retries keep the same downstream veto as the publication pipeline.
  if(eligible.some(s=>['pending','processing'].includes(s.processing_status))) food={state:'pending'};
  else {
    const terminal=eligible.find(s=>{
      if(dedicated(s) || daily.excludedSourceIds?.includes(s.id) || intentional(s,snap.data,w.weekday)) return false;
      // A current read-only reconciliation covers recoverable historical failed
      // evidence. Staged/ok alone never proves that publication succeeded.
      if(daily.alertSnapshot?.sources.some(row=>row.id===s.id)) return false;
      const caption=classifyCaption(s.caption);
      try {
        if(!validateCurrentDay({day_of_week:caption.day,day_evidence:s.caption,poster_evidence:s.caption},w.weekday,scan.day)) return false;
      } catch {return false;}
      return caption.day===w.weekday && ['week','ambiguous'].includes(caption.kind)
        && importAlertObservation(s,{eligible:true,resolution:'unresolved'}).state==='attention';
    });
    if(terminal) {
      food={state:'attention'};
      cause=importAlertObservation(terminal,{eligible:true,resolution:'unresolved'}).code;
    } else if(daily.requiresWrite && food.state!=='suppressed') food={state:'attention'};
    // Staff-locked values retained as the only hold are not a failure; no email.
    else if(food.state==='attention' && staffProtectionOnly(daily,snap.data,scan.day,w.weekday)) food={state:'suppressed'};
    else if(!eligible.length || !sourceIds.length) food={state:'suppressed'};
    else if(food.state==='unknown') food={state:'pending'};
    // Published without a printed price: not a failure, but staff are told.
    if(daily.pricelessOffers?.length && ['resolved','suppressed'].includes(food.state)) {food={state:'attention'};cause='publication_blocked';}
  }
  // Do not fabricate a failure from a failed image with no explicit current-day
  // specials caption. Unknown coverage is pending review, not claimed evidence.
  let delivery={state:'suppressed',cause:'delivery_failed'};
  const manual=snap.data[5][0]?.value ?? 'auto';
  const expected=await reconcileDelivery(env,{sourceIds,observedAt:new Date(now).toISOString(),inspectOnly:true});
  if(w.open && manual==='auto') {
    const saved=snap.data[6].find(s=>s.id===1);
    if(expected.expectedActive) delivery.state=resolveDeliveryDisplay(manual,saved,new Date(now))==='available'?'resolved':'attention';
    else if(['pending','withheld'].includes(expected.status)) delivery.state='pending';
  }
  // Diagnostics for the email only; never part of the state, cause or proof.
  const detail=dailyAlertDetail(daily,snap.data,scan.day,w.weekday);
  const deliveryDetail=deliveryAlertDetail(snap.data,expected,now);
  if(detail) detail.delivery=deliveryDetail;
  delivery.detail={scope:'delivery',day:scan.day,weekday:detail?.weekday,delivery:deliveryDetail};
  const weekly=await assessWeekly(env,scan,snap,now,sourceIds);
  let wing={state:'pending',cause:'wing_wednesday_failed',detail:null};
  try {wing=await assessWing(env,scan,snap,now);} catch {safeError();}
  // The same held poster as an unsent daily alert: one email that names both.
  // Once the daily email has gone, Wing Wednesday needs its own.
  if(wing.state==='attention' && food.state==='attention' && detail) {
    const dailyOpen=await env.DB.prepare(`SELECT 1 FROM facebook_alert_incidents WHERE incident_key=?1 AND dispatch_state<>'ready'`).bind(`${scan.day}:daily:publication_blocked`).first();
    if(!dailyOpen) {
      detail.wingWednesday={reason:wing.detail?.reason,editorUrl:wing.detail?.editorUrl};
      wing={...wing,state:'suppressed',fingerprint:undefined,detail:null};
    }
  }
  return {daily:{state:food.state,cause,detail},delivery,weekly,wing};
}

// Weekly Lunch and Wing Wednesday: the current failure has its own fingerprinted key.
// Every other incident of the day in that scope takes the current state (superseded by a newer,
// different failure, or resolved/pending/suppressed), so an unsent stale
// failure cannot send and a resolution clears all of them.
function recordFingerprinted(env,scan,scope,code,observation,evidence) {
  const fence=alertEvidenceFence(evidence,6);
  const key=observation.state==='attention' && observation.fingerprint ? `${scan.day}:${scope}:${code}:${observation.fingerprint}` : '';
  const others=env.DB.prepare(`UPDATE facebook_alert_incidents SET state=?3,observed_ms=?4
    WHERE day=?1 AND scope='${scope}' AND incident_key<>?2 AND observed_ms<=?4
      AND EXISTS(SELECT 1 FROM facebook_alert_scans WHERE day=?1 AND token=?5 AND completed_ms IS NOT NULL)
      ${fence.sql}`).bind(scan.day,key,observation.state==='attention'?'suppressed':observation.state,scan.started_ms,scan.token,...fence.args);
  return key ? [others,recordVerified(env,scan,scope,observation,evidence,key)] : [others];
}

function recordVerified(env,scan,scope,observation,evidence,incidentKey=null) {
  const {hash}=evidence,fence=alertEvidenceFence(evidence,10);
  const code=scope==='daily'?'publication_blocked':scope==='weekly'?'weekly_lunch_failed':scope==='wing'?'wing_wednesday_failed':'delivery_failed';
  const deliveryEnd=Date.parse(deliveryWindow(new Date(scan.completed_ms)).expiresAt);
  const proof=JSON.stringify({version:1,token:scan.token,hash,cause:observation.cause,parser:scan.parser,
    ...(observation.fingerprint?{fingerprint:observation.fingerprint}:{}),
    expires_ms:Math.min(scan.completed_ms+FRESH_MS,deliveryEnd+(scope==='delivery'?0:5*3600000))});
  return env.DB.prepare(`INSERT INTO facebook_alert_incidents
    (incident_key,day,scope,code,state,first_seen_ms,observed_ms,due_ms,proof_json)
    SELECT ?1,?2,?3,?4,?5,?6,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM facebook_alert_scans
      WHERE day=?2 AND token=?9 AND completed_ms IS NOT NULL)
      ${fence.sql}
      AND (?5='attention' OR EXISTS(SELECT 1 FROM facebook_alert_incidents WHERE incident_key=?1))
    ON CONFLICT(incident_key) DO UPDATE SET state=excluded.state,observed_ms=excluded.observed_ms,proof_json=excluded.proof_json,
      first_seen_ms=CASE WHEN facebook_alert_incidents.state='attention' AND excluded.state='attention'
        THEN facebook_alert_incidents.first_seen_ms ELSE excluded.first_seen_ms END,
      due_ms=CASE WHEN facebook_alert_incidents.state='attention' AND excluded.state='attention'
        THEN facebook_alert_incidents.due_ms ELSE excluded.due_ms END
    WHERE excluded.observed_ms>=facebook_alert_incidents.observed_ms`)
    .bind(incidentKey ?? `${scan.day}:${scope}:${code}`,scan.day,scope,code,observation.state,scan.started_ms,
      scan.completed_ms+ALERT_GRACE_MS,proof,scan.token,...fence.args);
}

export async function revalidateAlert(env,row,{withEvidence=false}={}) {
  if(!active(env) || !row.proof_json) return false;
  const now=Date.now(),w=deliveryWindow(new Date(now));
  if(w.day!==row.day || hour(now)<7 || hour(now)>=20 || (row.scope==='delivery' && !w.open)) return false;
  const proof=JSON.parse(row.proof_json);
  if(proof.version!==1 || proof.parser!==parserVersionFor(env)
    || !Number.isSafeInteger(proof.expires_ms) || now>=proof.expires_ms) return false;
  const scan=await env.DB.prepare('SELECT * FROM facebook_alert_scans WHERE day=?1 AND token=?2')
    .bind(row.day,proof.token).first();
  if(!scan?.completed_ms || scan.evaluation_state!=='complete' || !scan.evaluated_ms || !scan.source_ids || scan.completed_ms>now || now-scan.completed_ms>FRESH_MS) return false;
  const before=await snapshot(env,scan);
  if(!before || before.hash!==proof.hash) return false;
  const outcome=(await assess(env,scan,before))[row.scope];
  const after=await snapshot(env,scan);
  // A weekly or Wing Wednesday proof authorizes only the same failure fingerprint.
  const valid=outcome?.state==='attention' && outcome.cause===proof.cause && after?.hash===proof.hash
    && (!['weekly','wing'].includes(row.scope) || (!!proof.fingerprint && outcome.fingerprint===proof.fingerprint && row.incident_key.endsWith(`:${proof.fingerprint}`)));
  return valid && withEvidence?{...after,detail:outcome.detail ?? null}:valid;
}

export async function dispatchVerifiedAlerts(env,{send,timeoutMs}={}) {
  if(!active(env)) return {status:'disabled'};
  // Mock transport is a function injected by tests, never an environment URL.
  // Provider configuration is resolved before any incident is claimed or fenced.
  const transport=env.SPECIALS_ALERT_MODE==='MOCK'?send:await alertTransport(env);
  if(typeof transport!=='function') return {status:env.SPECIALS_ALERT_MODE==='EMAIL'?'unconfigured':'disabled'};
  try {
    const counts={sent:0,uncertain:0,superseded:0};
    for(let i=0;i<MAX_DISPATCH_PER_RUN;i++) {
      const result=await dispatchAlert(env.DB,transport,{enabled:true,requireProof:true,revalidate:row=>revalidateAlert(env,row,{withEvidence:true}),timeoutMs});
      if(result.status==='idle') break;
      if(Object.hasOwn(counts,result.status)) counts[result.status]++;
    }
    console.log('Facebook alert dispatch',counts);
    return counts;
  } catch {safeError();return {status:'unavailable'};}
}

// Content-free health data for independent monitoring. Even an empty database
// returns counts; a missing heartbeat must not be mistaken for a healthy zero.
export async function readAlertHealth(env,now=Date.now()) {
  const day=deliveryWindow(new Date(now)).day;
  return env.DB.prepare(`SELECT
    (SELECT MAX(evaluated_ms) FROM facebook_alert_scans WHERE evaluation_state='complete') AS last_completed_ms,
    (SELECT MAX(completed_ms) FROM facebook_alert_scans) AS last_scan_completed_ms,
    (SELECT count(*) FROM facebook_alert_scans WHERE day=?1 AND completed_ms IS NULL) AS incomplete_scans,
    (SELECT count(*) FROM facebook_alert_scans WHERE day=?1 AND evaluation_state='pending') AS pending_evaluations,
    (SELECT count(*) FROM facebook_alert_scans WHERE day=?1 AND evaluation_state='failed') AS failed_evaluations,
    (SELECT count(*) FROM facebook_alert_scans WHERE day=?1 AND evaluation_state='skipped') AS skipped_evaluations,
    (SELECT count(*) FROM facebook_alert_incidents WHERE dispatch_state='uncertain') AS uncertain_sends,
    count(*) AS actionable,
    COALESCE(sum(CASE WHEN last_error='send_failed' THEN 1 ELSE 0 END),0) AS send_failures
    FROM facebook_alert_incidents WHERE day=?1 AND state='attention' AND sent_ms IS NULL`).bind(day).first();
}

export async function finishAlertScan(env,context,sourceIds,options={}) {
  if(!context || !active(env)) return;
  const mark=async(state,error)=>env.DB.prepare(`UPDATE facebook_alert_scans
    SET evaluation_state=?3,evaluation_error=?4,evaluated_ms=NULL
    WHERE day=?1 AND token=?2 AND evaluation_state<>'complete'`)
    .bind(context.day,context.token,state,error).run();
  try {
    const now=Date.now();
    if(deliveryWindow(new Date(now)).day!==context.day || hour(now)<7 || hour(now)>=20) {
      await mark('skipped','outside_window');return;
    }
    const result=await env.DB.prepare(`UPDATE facebook_alert_scans SET source_ids=?3,completed_ms=?4
      WHERE day=?1 AND token=?2 AND evaluation_state<>'complete'`).bind(context.day,context.token,JSON.stringify([...new Set(sourceIds)].sort()),now).run();
    if(result.meta?.changes!==1) return;
    const scan=await env.DB.prepare('SELECT * FROM facebook_alert_scans WHERE day=?1 AND token=?2').bind(context.day,context.token).first();
    if(!scan) return;
    const before=await snapshot(env,scan);
    if(!before) {await mark('skipped','evidence_changed');return;}
    const outcomes=await assess(env,scan,before),after=await snapshot(env,scan);
    if(after?.hash!==before.hash) {await mark('skipped','evidence_changed');return;}
    // Both incident outcomes and successful evaluation are committed together.
    // A failed batch rolls back all three, and the token/fence protects against
    // newer scans or business writes between assessment and persistence.
    const fence=alertEvidenceFence(before,4);
    const persisted=await env.DB.batch([
      ...['daily','delivery'].map(scope=>recordVerified(env,scan,scope,outcomes[scope],before)),
      ...recordFingerprinted(env,scan,'weekly','weekly_lunch_failed',outcomes.weekly,before),
      ...recordFingerprinted(env,scan,'wing','wing_wednesday_failed',outcomes.wing,before),
      env.DB.prepare(`UPDATE facebook_alert_scans SET evaluated_ms=?3,evaluation_state='complete',evaluation_error=NULL
        WHERE day=?1 AND token=?2 ${fence.sql}`)
        .bind(scan.day,scan.token,Date.now(),...fence.args),
    ]);
    if(persisted.at(-1).meta?.changes!==1) {await mark('skipped','evidence_changed');return;}
    console.log('Facebook alert observation',{daily:outcomes.daily.state,delivery:outcomes.delivery.state,weekly:outcomes.weekly.state,wing:outcomes.wing.state});
    await dispatchVerifiedAlerts(env,options);
    console.log('Facebook alert health',await readAlertHealth(env,now));
    // Bounded retention, never deletes this day's sent deduplication records.
    await env.DB.prepare(`DELETE FROM facebook_alert_incidents WHERE incident_key IN
      (SELECT incident_key FROM facebook_alert_incidents WHERE observed_ms<?1 AND dispatch_state<>'uncertain' LIMIT 100)`)
      .bind(now-14*86400000).run();
    await env.DB.prepare('DELETE FROM facebook_alert_scans WHERE started_ms<?1').bind(now-14*86400000).run();
  } catch {
    try {await mark('failed','evaluation_failed');} catch { /* Missing/stale completion remains unhealthy during D1 outage. */ }
    safeError();
  }
}
