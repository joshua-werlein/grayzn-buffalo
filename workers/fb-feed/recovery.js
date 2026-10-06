// Source identity and business reconciliation stay in their existing modules.
// This module owns only the durable, fenced processing-attempt lifecycle.
export const MAX_IMPORT_ATTEMPTS = 3;
export const IMPORT_LEASE_MS = 20 * 60 * 1000;
export const IMPORT_RETRY_MS = 30 * 60 * 1000;
// Graph/legacy rows can contain +0000 (valid JS, not a SQLite date). Do not
// rewrite audit timestamps or source identities just to make SQL parse them.
const CREATED_AT_SQL = `julianday(CASE WHEN substr(fb_created_time,-5,1) IN ('+','-')
  THEN substr(fb_created_time,1,length(fb_created_time)-2)||':'||substr(fb_created_time,-2)
  ELSE fb_created_time END)`;

// Parameter contract shared by every attempt-side effect: id, token, current time.
export const OWNS_ATTEMPT_SQL = `EXISTS(SELECT 1 FROM special_imports i
  WHERE i.id=?1 AND i.attempt_token=?2 AND i.processing_status='processing'
    AND i.review_status='pending' AND julianday(i.lease_expires_at)>julianday(?3)
    AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=i.fb_post_id
      AND newer.parser_version=i.parser_version AND newer.rowid>i.rowid))`;

export function isTransientFailure(error) {
  const message = String(error);
  // Structured response failures keep the existing within-attempt retry contract.
  if (/json[ _]mode|json[ _]schema/i.test(message)) return false;
  // Workers AI binding errors may expose only an internal code/message.
  // Account allocation exhaustion (3036) is not temporary capacity (3040).
  // https://developers.cloudflare.com/workers-ai/platform/errors/
  const code=Number(error?.code ?? message.match(/\b(3003|3006|3007|3008|3023|3036|3039|3040|3041|3042|5004|5005|5007|5016|5018|5019|5035)\b/)?.[1]);
  if ([3003,3006,3023,3036,3039,3041,3042,5004,5005,5007,5016,5018,5019,5035].includes(code)) return false;
  if ([3007,3008,3040].includes(code)) return true;
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ??
    message.match(/\b(4\d\d|5\d\d)\b/)?.[1]);
  if (status >= 400 && status < 600) return [408,425,429].includes(status) || status >= 500;
  return /fetch failed|network|timed?\s*out|timeout|temporar|overload|unavailable|rate.?limit|too many requests|connection (?:reset|closed)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(message);
}

export async function claimImportAttempt(env, id, {window,modelId,parserVersion,mode}) {
  const now = new Date(Date.now());
  const token = crypto.randomUUID();
  const prepare = (sql,...args)=>env.DB.prepare(sql).bind(...args);
  const args = [id,token,now.toISOString()];
  const results = await env.DB.batch([
    prepare(`UPDATE special_imports SET processing_status='processing',attempt_token=?2,
      lease_expires_at=?4,next_attempt_at=?5,retry_count=retry_count+1
      WHERE id=?1 AND review_status='pending' AND retry_count<?6
        AND parser_version=?7 AND model_id=?8
        AND ${CREATED_AT_SQL}>=julianday(?9) AND ${CREATED_AT_SQL}<julianday(?10)
        AND ${CREATED_AT_SQL}<=julianday(?3)
        AND (next_attempt_at IS NULL OR julianday(next_attempt_at)<=julianday(?3))
        AND (processing_status='pending' OR (processing_status='processing' AND julianday(lease_expires_at)<=julianday(?3)))
        AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=special_imports.fb_post_id
          AND newer.parser_version=special_imports.parser_version AND newer.rowid>special_imports.rowid)`,
      ...args,new Date(now.getTime()+IMPORT_LEASE_MS).toISOString(),new Date(now.getTime()+IMPORT_RETRY_MS).toISOString(),
      MAX_IMPORT_ATTEMPTS,parserVersion,modelId,new Date(window.since*1000).toISOString(),new Date(window.until*1000).toISOString()),
    prepare(`INSERT INTO special_import_events(import_id,event_type,detail,occurred_at)
      SELECT ?1,'fetch',?4,?3 WHERE ${OWNS_ATTEMPT_SQL}`,...args,`mode:${mode}; attempt:${token}`),
    prepare(`INSERT INTO special_import_events(import_id,event_type,detail,occurred_at)
      SELECT id,CASE WHEN retry_count=1 THEN 'classify' ELSE 'retry' END,
        CASE WHEN retry_count=1 THEN classification_reason ELSE 'Recovery attempt '||retry_count||'/3' END,?3
      FROM special_imports WHERE id=?1 AND ${OWNS_ATTEMPT_SQL}`,...args),
    prepare(`SELECT * FROM special_imports WHERE id=?1 AND ${OWNS_ATTEMPT_SQL}`,...args),
  ]);
  return results.at(-1)?.results?.[0] ?? null;
}

export async function attemptEvent(env, record, type, detail) {
  return env.DB.prepare(`INSERT INTO special_import_events(import_id,event_type,detail,occurred_at)
    SELECT ?1,?4,?5,?3 WHERE ${OWNS_ATTEMPT_SQL}`)
    .bind(record.id,record.attempt_token,new Date(Date.now()).toISOString(),type,detail).run();
}

export async function saveAttemptImage(env, record, image) {
  const result = await env.DB.prepare(`UPDATE special_imports SET image_r2_key=?4,image_hash=?5
    WHERE id=?1 AND ${OWNS_ATTEMPT_SQL}`)
    .bind(record.id,record.attempt_token,new Date(Date.now()).toISOString(),image.imageR2Key,image.imageHash).run();
  return result.meta?.changes === 1;
}

export async function finishImportAttempt(env, record, outcome) {
  const now = new Date(Date.now()).toISOString();
  const args = [record.id,record.attempt_token,now];
  const prepare = (sql,...values)=>env.DB.prepare(sql).bind(...values);
  const event = (type,detail)=>prepare(`INSERT INTO special_import_events(import_id,event_type,detail,occurred_at)
    SELECT ?1,?4,?5,?3 WHERE ${OWNS_ATTEMPT_SQL}`,...args,type,detail);
  const status = outcome.status;
  const eventType = {staged:'stage',failed:'fail',skipped:'skip',pending:'requeue'}[status];
  // Events and status commit together. A late attempt cannot write even its audit.
  const results = await env.DB.batch([
    ...(outcome.lastError ? [event('error',outcome.lastError)] : []),
    event('validate',outcome.reason),
    event(eventType,status==='pending' ? `${outcome.reason}; retry not before ${record.next_attempt_at}` : outcome.reason),
    prepare(`UPDATE special_imports SET extracted_json=?4,candidate_json=?5,validation_result=?6,
      validation_reason=?7,processing_status=?8,processed_at=?9,last_error=?10,failure_kind=?11,
      lease_expires_at=NULL,next_attempt_at=?12,
      image_r2_key=CASE WHEN ?13 THEN NULL ELSE image_r2_key END,
      image_hash=CASE WHEN ?13 THEN NULL ELSE image_hash END,
      target_kind=COALESCE(?14,target_kind),target_collection_id=COALESCE(?15,target_collection_id)
      WHERE id=?1 AND ${OWNS_ATTEMPT_SQL}`,...args,
      outcome.extractedJson ?? null,outcome.candidateJson ?? null,outcome.validationResult ?? null,
      outcome.reason,status,outcome.processedAt ?? null,outcome.lastError ?? null,outcome.failureKind ?? null,
      status==='pending' ? record.next_attempt_at : null,outcome.clearImage ? 1 : 0,
      outcome.reason==='mexican night evidence' ? 'section' : null,
      outcome.reason==='mexican night evidence' ? 'mexican-night' : null),
  ]);
  return results.at(-1)?.meta?.changes === 1;
}

export async function retireImportAttempts(env,{window,modelId,parserVersion,closed}) {
  const now=new Date(Date.now()).toISOString();
  const args=[now,new Date(window.since*1000).toISOString(),closed ? 1 : 0,parserVersion,modelId,MAX_IMPORT_ATTEMPTS];
  const eligible=`review_status='pending' AND parser_version=?4 AND model_id=?5
    AND (processing_status='pending' OR (processing_status='processing' AND julianday(lease_expires_at)<=julianday(?1)))
    AND (${CREATED_AT_SQL}<julianday(?2) OR ?3=1 OR retry_count>=?6)`;
  const kind=`CASE WHEN ${CREATED_AT_SQL}<julianday(?2) OR ?3=1 THEN 'expired' ELSE 'exhausted' END`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO special_import_events(import_id,event_type,detail,occurred_at)
      SELECT id,'fail',${kind},?1 FROM special_imports WHERE ${eligible}`).bind(...args),
    env.DB.prepare(`UPDATE special_imports SET processing_status='failed',failure_kind=${kind},
      validation_result=NULL,validation_reason=${kind},attempt_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL
      WHERE ${eligible}`).bind(...args),
  ]);
}
