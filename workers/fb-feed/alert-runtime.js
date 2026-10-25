import {parserVersionFor,classifyCaption} from './classify.js';
import {reconcileToday} from './guarded-auto.js';
import {reconcileDelivery} from './delivery.js';
import {validateCurrentDay} from './reconcile.js';
import {deliveryWindow} from '../../src/lib/delivery.js';
import {dailyPublicationObservation,importAlertObservation} from './alert-policy.js';
import {ALERT_GRACE_MS,dispatchAlert,alertEvidenceFence} from './alert-store.js';
import {emailTransport} from './alert-email.js';

const MODES=['OBSERVE','MOCK','EMAIL'];
const FRESH_MS=90*60*1000;
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
  try {
    const c=JSON.parse(s.candidate_json || s.extracted_json);
    return ['weekly-lunch','mexican-night'].includes(c?.type) && !('offers' in c) && !('day_of_week' in c);
  } catch {return s.target_kind==='section' || (s.target_kind==='week' && s.target_day==null);}
}
function intentional(s,data,weekday) {
  const [,weeks,collections,groups,slots]=data;
  if(weeks.length!==1 || !s.target_service) return false;
  const collection=collections.find(c=>c.weekly_special_id===weeks[0].id && c.kind==='week');
  const destinations=groups.filter(g=>g.collection_id===collection?.id && g.day_of_week===weekday && g.service===s.target_service);
  return destinations.length===1 && (destinations[0].enabled===0 || slots.some(p=>p.group_id===destinations[0].id && p.manual_locked===1 && p.content));
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
    else if(!eligible.length || !sourceIds.length) food={state:'suppressed'};
    else if(food.state==='unknown') food={state:'pending'};
  }
  // Do not fabricate a failure from a failed image with no explicit current-day
  // specials caption. Unknown coverage is pending review, not claimed evidence.
  let delivery={state:'suppressed',cause:'delivery_failed'};
  const manual=snap.data[5][0]?.value ?? 'auto';
  if(w.open && manual==='auto') {
    const expected=await reconcileDelivery(env,{sourceIds,observedAt:new Date(now).toISOString(),inspectOnly:true});
    const saved=snap.data[6].find(s=>s.id===1);
    if(expected.expectedActive) delivery.state=saved?.active===1 && saved.day===w.day && saved.expires_at===w.expiresAt?'resolved':'attention';
    else if(['pending','withheld'].includes(expected.status)) delivery.state='pending';
  }
  return {daily:{state:food.state,cause},delivery};
}

function recordVerified(env,scan,scope,observation,evidence) {
  const {hash}=evidence,fence=alertEvidenceFence(evidence,10);
  const code=scope==='daily'?'publication_blocked':'delivery_failed';
  const deliveryEnd=Date.parse(deliveryWindow(new Date(scan.completed_ms)).expiresAt);
  const proof=JSON.stringify({version:1,token:scan.token,hash,cause:observation.cause,parser:scan.parser,
    expires_ms:Math.min(scan.completed_ms+FRESH_MS,deliveryEnd+(scope==='daily'?5*3600000:0))});
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
    .bind(`${scan.day}:${scope}:${code}`,scan.day,scope,code,observation.state,scan.started_ms,
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
  const valid=outcome?.state==='attention' && outcome.cause===proof.cause && after?.hash===proof.hash;
  return valid && withEvidence?after:valid;
}

export async function dispatchVerifiedAlerts(env,{send,timeoutMs}={}) {
  if(!active(env)) return {status:'disabled'};
  // Mock transport is a function injected by tests, never an environment URL.
  const transport=env.SPECIALS_ALERT_MODE==='MOCK'?send:emailTransport(env);
  if(typeof transport!=='function') return {status:env.SPECIALS_ALERT_MODE==='EMAIL'?'unconfigured':'disabled'};
  try {
    const counts={sent:0,uncertain:0,superseded:0};
    for(let i=0;i<2;i++) {
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
      env.DB.prepare(`UPDATE facebook_alert_scans SET evaluated_ms=?3,evaluation_state='complete',evaluation_error=NULL
        WHERE day=?1 AND token=?2 ${fence.sql}`)
        .bind(scan.day,scan.token,Date.now(),...fence.args),
    ]);
    if(persisted[2].meta?.changes!==1) {await mark('skipped','evidence_changed');return;}
    console.log('Facebook alert observation',{daily:outcomes.daily.state,delivery:outcomes.delivery.state});
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
