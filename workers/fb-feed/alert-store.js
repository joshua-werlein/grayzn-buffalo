import {deliveryWindow} from '../../src/lib/delivery.js';

export const ALERT_GRACE_MS = 30 * 60 * 1000;
export const ALERT_LEASE_MS = 5 * 60 * 1000;
export const ALERT_SEND_TIMEOUT_MS = 5_000;
export const ALERT_CODES = Object.freeze({
  import_failed: 'An eligible Facebook source could not be imported.',
  validation_rejected: 'Facebook evidence failed validation and still needs review.',
  ai_budget_exhausted: 'The AI budget prevented processing an eligible Facebook source.',
  retry_exhausted: 'Automatic Facebook import retries were exhausted.',
  publication_blocked: 'Available Facebook evidence could not be fully published.',
  delivery_failed: 'Confirmed delivery evidence could not be activated automatically.',
  automation_failed: 'Facebook automation encountered a persistent technical failure.',
});

function timestamp(value) {
  const n = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('Invalid alert timestamp');
  return n;
}

// Compare the complete transient read snapshot in the authorizing SQL statement.
// Table names/filters are fixed here; column identifiers originate in SELECT *,
// are restricted to plain identifiers, and values are always bound JSON. No raw
// evidence is persisted in the alert tables or logged. No business-write triggers
// are needed (D1 counts their side effects in meta.changes).
export function alertEvidenceFence({data,sourceIds,day},start) {
  if(!Array.isArray(data) || data.length!==8 || data.some(rows=>!Array.isArray(rows))) throw Error('Invalid alert evidence');
  const json=`?${start}`,ids=`?${start+1}`,date=`?${start+2}`;
  // D1 limits expression depth to 100. Keep wide source-row comparisons balanced
  // rather than building a left-deep chain across every schema column.
  const and=terms=>terms.length<2?(terms[0]??'1=1'):
    `(${and(terms.slice(0,Math.floor(terms.length/2)))} AND ${and(terms.slice(Math.floor(terms.length/2)))})`;
  const tables=[['special_imports',`t.id IN (SELECT value FROM json_each(${ids}))`],
    ['weekly_specials',`t.week_start_date<=${date} AND t.week_end_date>=${date}`],
    ['special_collections','1=1'],['special_groups','1=1'],['special_slots','1=1'],
    ['settings',"t.key='delivery_display'"],['delivery_automation','1=1'],['special_migration_checks','1=1']];
  const sql=tables.map(([table,filter],i)=>{
    const keys=Object.keys(data[i][0]??{});
    if(keys.some(k=>!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(k))) throw Error('Invalid evidence column');
    const match=and(keys.map(k=>{
      const column=i===0 && k==='superseded'
        ? '(EXISTS(SELECT 1 FROM special_imports n WHERE n.fb_post_id=t.fb_post_id AND n.parser_version=t.parser_version AND n.rowid>t.rowid))'
        : `t."${k}"`;
      return `${column} IS json_extract(e.value,'$.${k}')`;
    }));
    return `AND (SELECT count(*) FROM ${table} t WHERE ${filter})=json_array_length(${json},'$[${i}]')
      AND NOT EXISTS(SELECT 1 FROM json_each(${json},'$[${i}]') e WHERE NOT EXISTS(
        SELECT 1 FROM ${table} t WHERE ${filter} AND ${match}))`;
  }).join('\n');
  return {sql,args:[JSON.stringify(data),JSON.stringify(sourceIds),day]};
}

// Caller supplies an observation timestamp tied to its fenced source snapshot,
// not the time an old result happens to finish. Unknown never clears an incident.
export async function recordAlertObservation(DB, {day, scope, code, state, observedAt}, {graceMs = ALERT_GRACE_MS, deliveryGuard = null, publicationGuard = null} = {}) {
  const observed = timestamp(observedAt);
  if (deliveryWindow(new Date(observed)).day !== day || !/^[a-zA-Z0-9_-]{1,100}$/.test(scope)
      || !Object.hasOwn(ALERT_CODES,code) || !Number.isSafeInteger(graceMs) || graceMs < 0) throw new TypeError('Invalid alert observation');
  if (state === 'unknown') return;
  if (!['attention','pending','resolved','suppressed'].includes(state)) throw new TypeError('Invalid alert state');
  const key = `${day}:${scope}:${code}`;
  // Integrated observations are accepted only while the sources and delivery
  // setting/state or publication revision still match. SQL is fixed application
  // code; callers cannot inject an arbitrary predicate.
  const snapshotGuard=deliveryGuard ?? publicationGuard;
  const sourceGuard = snapshotGuard ? `
    AND json_array_length(?8)=json_array_length(?9)
    AND (SELECT count(*) FROM special_imports WHERE id IN (SELECT value FROM json_each(?9)) AND parser_version=?10)=json_array_length(?8)
    AND NOT EXISTS(SELECT 1 FROM json_each(?8) j WHERE NOT EXISTS(
      SELECT 1 FROM special_imports i WHERE i.id=json_extract(j.value,'$.id') AND i.parser_version=?10
      AND i.extracted_json IS json_extract(j.value,'$.extracted_json')
      AND i.candidate_json IS json_extract(j.value,'$.candidate_json')
      AND i.processing_status=json_extract(j.value,'$.processing_status')
      AND i.validation_result IS json_extract(j.value,'$.validation_result')
      AND i.review_status=json_extract(j.value,'$.review_status')
      AND i.fb_created_time=json_extract(j.value,'$.fb_created_time')
      AND i.image_r2_key IS json_extract(j.value,'$.image_r2_key')
      AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=i.fb_post_id
        AND newer.parser_version=i.parser_version AND newer.rowid>i.rowid)))` : '';
  const guard=sourceGuard+(deliveryGuard ? `
    AND COALESCE((SELECT value FROM settings WHERE key='delivery_display'),'auto')=?11
    AND NOT EXISTS(SELECT 1 FROM delivery_automation WHERE observed_at>?12)
    AND (?11<>'auto' OR
      (?5='attention' AND NOT EXISTS(SELECT 1 FROM delivery_automation WHERE observed_at>=?12
        OR (day=?2 AND active=1 AND expires_at=?13))) OR
      (?5<>'attention' AND EXISTS(SELECT 1 FROM delivery_automation WHERE day=?2 AND observed_at=?12
        AND source_ids=?9 AND expires_at=?13 AND active=?14)))` : publicationGuard ? `
    AND EXISTS(SELECT 1 FROM special_collections WHERE id=?11 AND revision=?12)
    AND (?5='pending' OR NOT EXISTS(SELECT 1 FROM special_imports WHERE id IN (SELECT value FROM json_each(?13))
      AND review_status='pending' AND processing_status IN ('pending','processing')))` : '');
  const args=[key,day,scope,code,state,observed,observed+graceMs];
  if (deliveryGuard) args.push(JSON.stringify(deliveryGuard.sources),JSON.stringify(deliveryGuard.sourceIds),
    deliveryGuard.parser,deliveryGuard.manual,deliveryGuard.observedAt,deliveryGuard.expiresAt,deliveryGuard.expectedActive?1:0);
  else if(publicationGuard) args.push(JSON.stringify(publicationGuard.sources),JSON.stringify(publicationGuard.sourceIds),
    publicationGuard.parser,publicationGuard.collectionId,publicationGuard.revision,JSON.stringify(publicationGuard.currentSourceIds));
  await DB.prepare(`INSERT INTO facebook_alert_incidents
    (incident_key,day,scope,code,state,first_seen_ms,observed_ms,due_ms)
    SELECT ?1,?2,?3,?4,?5,?6,?6,?7 WHERE 1=1 ${guard}
      ${snapshotGuard ? "AND (?5='attention' OR EXISTS(SELECT 1 FROM facebook_alert_incidents WHERE incident_key=?1))" : ''}
    ON CONFLICT(incident_key) DO UPDATE SET
      state=excluded.state,observed_ms=excluded.observed_ms,
      first_seen_ms=CASE WHEN facebook_alert_incidents.state='attention' AND excluded.state='attention'
        THEN facebook_alert_incidents.first_seen_ms ELSE excluded.first_seen_ms END,
      due_ms=CASE WHEN facebook_alert_incidents.state='attention' AND excluded.state='attention'
        THEN facebook_alert_incidents.due_ms ELSE excluded.due_ms END
    WHERE excluded.observed_ms>facebook_alert_incidents.observed_ms
      ${snapshotGuard ? "OR (excluded.observed_ms=facebook_alert_incidents.observed_ms AND excluded.state<>'attention')" : ''}`)
    .bind(...args).run();
  return key;
}

// Transport is injected; the Worker selects a gated native binding or test mock.
// A lease protects preparation ONLY. The final atomic decision permanently
// fences provider invocation as uncertain before crossing the external boundary.
// Timeouts, process loss and ambiguous errors never authorize automatic resend.
export async function dispatchAlert(DB, send, {enabled = false, now = () => Date.now(), requireProof=false, revalidate=null, timeoutMs=ALERT_SEND_TIMEOUT_MS} = {}) {
  if (!enabled) return {status:'disabled'};
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>ALERT_SEND_TIMEOUT_MS) throw new TypeError('Invalid send timeout');
  const started = timestamp(now()), window = deliveryWindow(new Date(started)), day = window.day;
  const token = crypto.randomUUID();
  const row = await DB.prepare(`UPDATE facebook_alert_incidents SET lease_token=?1,lease_until_ms=?2,attempts=attempts+1
    WHERE incident_key=(SELECT incident_key FROM facebook_alert_incidents
      WHERE day=?3 AND state='attention' AND sent_ms IS NULL AND dispatch_state='ready' AND due_ms<=?4
        AND (lease_until_ms IS NULL OR lease_until_ms<=?4)
        AND (code<>'delivery_failed' OR ?5=1)
        ${requireProof?'AND proof_json IS NOT NULL':''}
      ORDER BY due_ms,incident_key LIMIT 1)
    RETURNING *`).bind(token,started+ALERT_LEASE_MS,day,started,window.open?1:0).first();
  if (!row) return {status:'idle'};
  let proof=null,evidence=null;
  if(requireProof || row.proof_json) {
    try {
      proof=JSON.parse(row.proof_json);
      if(typeof revalidate!=='function' || !(evidence=await revalidate(row))) return {status:'superseded'};
    } catch {return {status:'superseded'};}
  }
  const checkedAt = timestamp(now());
  const checkedWindow = deliveryWindow(new Date(checkedAt));
  if(proof && (!Number.isSafeInteger(proof.expires_ms) || checkedAt>=proof.expires_ms)) return {status:'superseded'};
  if (checkedWindow.day !== row.day || (row.code==='delivery_failed' && !checkedWindow.open)) return {status:'superseded'};
  if(proof && (!evidence?.data || evidence.day!==row.day)) return {status:'superseded'};
  const fence=proof?alertEvidenceFence(evidence,8):{sql:'',args:[]};
  // This UPDATE is the authorization boundary. Business evidence is compared
  // inside the same atomic statement that permanently fences provider invocation.
  const stillCurrent = await DB.prepare(`UPDATE facebook_alert_incidents
    SET dispatch_state='uncertain',authorized_ms=?3
    WHERE incident_key=?1 AND lease_token=?2 AND state='attention' AND sent_ms IS NULL AND dispatch_state='ready' AND lease_until_ms>?3
      AND observed_ms=?4 AND due_ms<=?3
      ${proof?`AND proof_json=?5 AND EXISTS(SELECT 1 FROM facebook_alert_scans
        WHERE day=?6 AND token=?7 AND evaluation_state='complete' AND evaluated_ms IS NOT NULL)`:''}
    ${fence.sql}
    RETURNING incident_key`)
    .bind(row.incident_key,token,checkedAt,row.observed_ms,...(proof?[row.proof_json,row.day,proof.token]:[]),...fence.args).first();
  if (!stillCurrent) return {status:'superseded'};
  // A timeout bounds the caller, NOT the provider. Retain uncertainty even if
  // the caller disappears. Late acceptance may acknowledge this exact token;
  // a late error or lost acknowledgement cannot reopen it.
  let timer;
  const attempt=(async()=>{
   try {
    const code=proof && Object.hasOwn(ALERT_CODES,proof.cause)?proof.cause:row.code;
    await send({incidentKey:row.incident_key,day:row.day,code,
      message:ALERT_CODES[code],reviewUrl:'https://grayznbuffalo.com/admin',
      signal:AbortSignal.timeout(timeoutMs)});
    const acknowledged = await DB.prepare(`UPDATE facebook_alert_incidents SET sent_ms=?3,dispatch_state='sent',lease_until_ms=NULL,last_error=NULL
      WHERE incident_key=?1 AND lease_token=?2 AND dispatch_state='uncertain'`).bind(row.incident_key,token,timestamp(now())).run();
    return {status:acknowledged.meta?.changes===1?'sent':'uncertain'};
   } catch {
    try {
      await DB.prepare(`UPDATE facebook_alert_incidents SET last_error='send_failed'
        WHERE incident_key=?1 AND lease_token=?2 AND dispatch_state='uncertain'`).bind(row.incident_key,token).run();
    } catch { /* The pre-send durable uncertainty remains even during D1 loss. */ }
    return {status:'uncertain'};
   }
  })();
  try {
    return await Promise.race([attempt,new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'uncertain'}),timeoutMs);})]);
  } finally {clearTimeout(timer);}
}
