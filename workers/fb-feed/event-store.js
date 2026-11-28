// Automatic writes for special events. Separate from the weekly specials: no
// collection revision, group or slot is read or written here, and every event
// write is fenced by that event's own revision.
// Statuses: published (shown until it expires); review (withheld: evidence was
// insufficient or contradictory; never shown, raises a Special Event alert, and
// staff may publish it from Automation Review); rejected (removed by staff, a
// tombstone); cancelled.
import {eventsModeOf,routeStoredSources} from './events.js';
import {canonicalizeSlotContent} from './reconcile.js';
import {parserVersionFor} from './classify.js';
import {verifiedPostTimes} from './graph.js';
import {sqlTime} from './mexican-night-defaults.js';

// A missing table (migration not yet applied) behaves exactly like OFF.
export async function activeEventsMode(env) {
  const mode=eventsModeOf(env);
  if (mode==='OFF') return mode;
  try { await env.DB.prepare('SELECT 1 FROM special_events LIMIT 1').all(); return mode; }
  catch { return 'OFF'; }
}
// Sources the daily publisher must skip: whole-poster promotions, and posts
// whose event staff edited or removed (removing an event must never push its
// poster into the daily specials).
export async function eventSourceIndexes(env,sources,today) {
  if (!sources.length) return new Set();
  const routes=routeStoredSources(sources,{today,canonicalize:canonicalizeSlotContent});
  if (await activeEventsMode(env)==='OFF') return new Set(routes.flatMap((r,i)=>r.retail?[i]:[]));
  const {results:held}=await env.DB.prepare(`SELECT source_post_id FROM special_events
    WHERE manual_locked=1 AND source_post_id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(sources.map(s=>s.fb_post_id))).all();
  const staff=new Set(held.map(e=>e.source_post_id));
  return new Set(routes.flatMap((r,i)=>r.retail || r.route==='event' || staff.has(sources[i].fb_post_id)?[i]:[]));
}

const SOURCES=`SELECT * FROM special_imports WHERE id IN (SELECT value FROM json_each(?1))
  AND parser_version=?2 AND ((processing_status='staged' AND validation_result='ok')
    OR (processing_status='failed' AND validation_result='rejected' AND extracted_json IS NOT NULL))
  AND image_r2_key IS NOT NULL AND review_status IN ('pending','accepted')`;
const valuesOf=(e,offers)=>JSON.stringify({title:e.title,event_date:e.event_date,time_text:e.time_text,
  start_time:e.start_time??null,end_time:e.end_time??null,details:e.details,offers});
const reasonText=list=>list.join('; ').slice(0,600);

export async function reconcileEvents(env,{sourceIds,today}) {
  const mode=await activeEventsMode(env);
  if (mode==='OFF' || !sourceIds.length) return {mode,changes:0};
  const {results:rows}=await env.DB.prepare(SOURCES).bind(JSON.stringify(sourceIds),parserVersionFor(env)).all();
  const routing=routeStoredSources(rows,{today,canonicalize:canonicalizeSlotContent});
  const times=await verifiedPostTimes(env,rows.filter((_,i)=>routing[i].route==='event'));
  let changes=0;
  for (let i=0;i<rows.length;i++) {
    // One event's failure never affects another event or the regular specials.
    try {
      const r=routing[i];
      if (r.route==='regular' || r.route==='retail') changes+=await withdrawRegular(env,rows[i]);
      else if (r.route==='mixed') await log(env,{source:rows[i].fb_post_id,action:'conflict',detail:r.reason}).run();
      else if (!r.cancellation) changes+=await applyDraft(env,rows[i],r,times.get(rows[i].id));
    } catch (error) { console.error('Special event reconcile error',{reason:String(error?.message ?? error).slice(0,200)}); }
  }
  // Evaluate cancellations against the publications from this same scan as well.
  for (const [i,r] of routing.entries()) {
    if (!r.cancellation) continue;
    try { changes+=await applyCancellation(env,rows[i],r,today,times.get(rows[i].id)); }
    catch (error) { console.error('Special event cancellation reconcile error',{reason:String(error?.message ?? error).slice(0,200)}); }
  }
  return {mode,changes};
}

async function readEvents(env,sql,...args) {
  const {results:events}=await env.DB.prepare(sql).bind(...args).all();
  if (!events.length) return [];
  const {results:offers}=await env.DB.prepare(`SELECT * FROM special_event_offers WHERE event_id IN (SELECT value FROM json_each(?1)) ORDER BY event_id,position`)
    .bind(JSON.stringify(events.map(e=>e.id))).all();
  return events.map(e=>({...e,offers:offers.filter(o=>o.event_id===e.id).map(o=>o.content)}));
}
// Automation may change an event only while it is exactly what automation wrote.
const untouched=e=>e.origin==='automation' && e.manual_locked===0 && valuesOf(e,e.offers)===e.last_auto_json;

function log(env,{event_id=null,source=null,action,detail}) {
  // Repeated crons record a decision once, until something changes.
  return env.DB.prepare(`INSERT INTO special_event_log(event_id,source_post_id,action,detail)
    SELECT ?1,?2,?3,?4 WHERE NOT EXISTS(SELECT 1 FROM special_event_log WHERE id=(SELECT MAX(id) FROM special_event_log WHERE source_post_id IS ?2)
      AND action=?3 AND detail=?4 AND event_id IS ?1)`).bind(event_id,source,action,detail.slice(0,1000));
}
const offerWrites=(env,id,offers,gate,...gateArgs)=>offers.map((content,i)=>env.DB.prepare(
  `INSERT INTO special_event_offers(event_id,position,content) SELECT ?1,?2,?3 WHERE ${gate}`).bind(id,i+1,content,...gateArgs));

// A Facebook post that no longer shows an event withdraws the event automation
// created for it, unless staff edited or removed that event.
async function withdrawRegular(env,row) {
  const [own]=await readEvents(env,`SELECT * FROM special_events WHERE source_post_id=?1 AND status IN ('review','published')`,row.fb_post_id);
  if (!own || !untouched(own) || own.status!=='published') return 0;
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE special_events SET status='review',review_reason=?3,revision=revision+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=?1 AND revision=?2 AND origin='automation' AND manual_locked=0 AND status='published'`)
      .bind(own.id,own.revision,'Withheld: the Facebook post no longer shows an event'),
    env.DB.prepare(`INSERT INTO special_event_log(event_id,source_post_id,action,detail)
      SELECT ?1,?2,'updated','Withheld: the Facebook post no longer shows an event' WHERE EXISTS(SELECT 1 FROM special_events WHERE id=?1 AND revision=?3)`)
      .bind(own.id,row.fb_post_id,own.revision+1),
  ]);
  return results[0]?.meta?.changes ?? 0;
}

// Sufficient evidence publishes; anything else is stored withheld with its
// reasons (an internal diagnostic, never shown or offered for approval).
async function applyDraft(env,row,routing,postedMs) {
  const d=routing.draft;
  if (routing.retail && !Number.isFinite(postedMs)) return 0;
  const status=routing.publish ? 'published' : 'review';
  const reason=status==='review' ? reasonText(d.review_reasons.map(r=>`Withheld: ${r}`)) : '';
  if (status==='review') console.warn('Special event withheld',{reasonCount:d.review_reasons.length});
  const evidence=JSON.stringify({...d.evidence,import_id:row.id,image_key:row.image_r2_key,verified_posted_ms:postedMs});
  // Match both original automation identity and the staff-visible date. A staff
  // date correction must not let a repost of the original event bypass removal.
  // Staff may enter the Black Friday event independently with edited offer text
  // and no Facebook link. Preserve that card and fence the insert on its title.
  const manualBlackFriday=(identity,date)=>`${identity}='black-friday' AND event_date=${date}
    AND manual_locked=1 AND lower(trim(title))='black friday deal'`;
  const sameEventSql=`fingerprint=?3 OR (${manualBlackFriday('?4','?2')}) OR (identity=?4 AND (event_date=?2 OR
    CASE WHEN json_valid(last_auto_json) THEN json_extract(last_auto_json,'$.event_date') END=?2))
    OR (status='rejected' AND COALESCE(identity,'')='' AND event_date=?2)`;
  const existing=await readEvents(env,`SELECT * FROM special_events WHERE source_post_id=?1
    OR (${sameEventSql})`,row.fb_post_id,d.event_date,d.fingerprint,d.identity);
  const manual=existing.find(e=>d.identity==='black-friday' && e.event_date===d.event_date
    && e.manual_locked===1 && e.title.trim().toLowerCase()==='black friday deal');
  if (manual) {
    await log(env,{event_id:manual.id,source:row.fb_post_id,action:'protected',detail:'Kept the staff-edited Black Friday event'}).run();
    return 0;
  }
  const linked=existing.find(e=>e.source_post_id===row.fb_post_id);
  const matches=existing.filter(e=>e.status!=='rejected' && e.identity===d.identity);
  const own=linked ?? (matches.length===1 && matches[0].fingerprint!==d.fingerprint ? matches[0] : null);
  if (own) {
    if (own.source_import_id===row.id) return 0;
    const previous=own.source_import_id
      ? (await verifiedPostTimes(env,[{fb_post_id:own.source_post_id}])).get(own.source_import_id) : NaN;
    const priorMs=Number.isFinite(previous) ? previous : Date.parse(own.source_created_time);
    const staffEdited=!untouched(own);
    const newer=Number.isFinite(postedMs) && (!Number.isFinite(priorMs) || postedMs>priorMs)
      && (!staffEdited || postedMs>sqlTime(own.updated_at));
    if (!['review','published'].includes(own.status)
      || ((staffEdited || !linked || own.source_import_id!==row.id) && !newer)
      || (status==='review' && (staffEdited || !linked))) {
      await log(env,{event_id:own.id,source:row.fb_post_id,action:staffEdited?'protected':'conflict',
        detail:`Kept the existing ${d.identity} event pending newer verified Facebook evidence`}).run();
      return 0;
    }
    const update={...d,time_text:d.time_text || own.time_text,start_time:d.start_time ?? own.start_time,
      end_time:d.end_time ?? own.end_time,details:d.details || own.details};
    const updatedValues=valuesOf(update,d.offers);
    // Offer and audit writes apply only if this exact automation update landed.
    const revision=own.revision+1;
    const landed=`EXISTS(SELECT 1 FROM special_events WHERE id=?1 AND revision=?4 AND last_auto_json=?5 AND manual_locked=0)`;
    const results=await env.DB.batch([
      env.DB.prepare(`UPDATE special_events SET title=?3,event_date=?4,time_text=?5,start_time=?6,end_time=?7,details=?8,status=?9,
        date_basis=?10,source_import_id=?11,fingerprint=?12,identity=?13,evidence_json=?14,last_auto_json=?15,review_reason=?16,
        source_post_id=?17,source_created_time=?18,source_permalink=?19,origin='automation',manual_locked=0,
        revision=revision+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=?1 AND revision=?2 AND status IN ('review','published')`)
        .bind(own.id,own.revision,update.title,update.event_date,update.time_text,update.start_time,update.end_time,update.details,status,d.date_basis,row.id,
          d.fingerprint,d.identity,evidence,updatedValues,reason,row.fb_post_id,row.fb_created_time,row.permalink_url ?? ''),
      env.DB.prepare(`DELETE FROM special_event_offers WHERE event_id=?1
        AND EXISTS(SELECT 1 FROM special_events WHERE id=?1 AND revision=?2 AND last_auto_json=?3 AND manual_locked=0)`).bind(own.id,revision,updatedValues),
      ...offerWrites(env,own.id,d.offers,landed,revision,updatedValues),
      env.DB.prepare(`INSERT INTO special_event_log(event_id,source_post_id,action,detail) SELECT ?1,?2,'updated',?3 WHERE ${landed}`)
        .bind(own.id,row.fb_post_id,`Updated from newer Facebook evidence (${status})`,revision,updatedValues),
    ]);
    return results[0]?.meta?.changes ?? 0;
  }
  // GET errors (including repeated 100/33), feed aging and legacy evidence_json
  // deletion markers cannot prove deletion. No positive deletion authority is
  // integrated: preserve removals even for a genuinely deleted original.
  const removed=existing.find(e=>e.status==='rejected');
  if (removed) {
    await log(env,{event_id:removed.id,source:row.fb_post_id,action:'protected',
      detail:'Removed by staff; no verified deletion authority is available, so this post does not recreate it'}).run();
    return 0;
  }
  const others=existing;
  const duplicate=others.find(e=>e.fingerprint===d.fingerprint);
  if (duplicate) {
    await log(env,{event_id:duplicate.id,source:row.fb_post_id,action:'duplicate',detail:`Same offers as an existing ${duplicate.status} event`}).run();
    return 0;
  }
  const sameEvent=others.find(e=>e.identity===d.identity);
  if (sameEvent) {
    await log(env,{event_id:sameEvent.id,source:row.fb_post_id,action:'conflict',
      detail:`Kept the existing ${sameEvent.status} ${d.identity} event on ${d.event_date}; this post printed different offers`}).run();
    return 0;
  }
  const id=`evt:${crypto.randomUUID()}`;
  const values=valuesOf(d,d.offers);
  const created='EXISTS(SELECT 1 FROM special_events WHERE id=?1 AND revision=0)';
  const results=await env.DB.batch([
    env.DB.prepare(`INSERT INTO special_events(id,title,event_date,time_text,start_time,end_time,details,status,origin,manual_locked,
      date_basis,source_post_id,source_import_id,source_created_time,source_permalink,fingerprint,identity,evidence_json,last_auto_json,review_reason)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,'automation',0,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18
      WHERE NOT EXISTS(SELECT 1 FROM special_events WHERE source_post_id=?10
        OR fingerprint=?14 OR (${manualBlackFriday('?15','?3')}) OR (identity=?15 AND (event_date=?3 OR
          CASE WHEN json_valid(last_auto_json) THEN json_extract(last_auto_json,'$.event_date') END=?3))
        OR (status='rejected' AND COALESCE(identity,'')='' AND event_date=?3))`)
      .bind(id,d.title,d.event_date,d.time_text,d.start_time,d.end_time,d.details,status,d.date_basis,row.fb_post_id,row.id,
        row.fb_created_time,row.permalink_url ?? '',d.fingerprint,d.identity,evidence,values,reason),
    ...offerWrites(env,id,d.offers,created),
    env.DB.prepare(`INSERT INTO special_event_log(event_id,source_post_id,action,detail) SELECT ?1,?2,'created',?3 WHERE ${created}`)
      .bind(id,row.fb_post_id,status==='published'?'published':reason),
  ]);
  return results[0]?.meta?.changes ?? 0;
}

async function applyCancellation(env,row,routing,today,postedMs) {
  const printed=routing.date?.date && routing.date.basis!=='publication-date' ? routing.date.date : null;
  const matches=await readEvents(env,`SELECT * FROM special_events WHERE identity=?1 AND status IN ('review','published')
    AND event_date>=?2 AND (?3 IS NULL OR event_date=?3)`,routing.cue.identity,today,printed);
  const e=matches.length===1 ? matches[0] : null;
  let hold='No unique matching event';
  if (!routing.verified || routing.date?.review) hold='Cancellation evidence is ambiguous';
  else if (e && !untouched(e)) hold='Staff control the event';
  else if (e) {
    const prior=e.source_import_id
      ? (await verifiedPostTimes(env,[{fb_post_id:e.source_post_id}])).get(e.source_import_id) : NaN;
    let recorded;
    try { recorded=JSON.parse(e.evidence_json)?.verified_posted_ms; } catch { /* Legacy evidence. */ }
    // The save time is a conservative upper bound when the source was pruned.
    const published=Number.isFinite(recorded) ? recorded : Number.isFinite(prior) ? prior : sqlTime(e.updated_at)+999;
    hold=Number.isFinite(postedMs) && postedMs>published ? '' : 'Cancellation is not verifiably newer than the published event';
  }
  if (!hold) {
    const token=crypto.randomUUID();
    const results=await env.DB.batch([
      env.DB.prepare(`UPDATE special_events SET status='cancelled',review_reason='Cancelled by a Facebook post',revision=revision+1,updated_at=CURRENT_TIMESTAMP,mutation_token=?6
        WHERE id=?1 AND revision=?2 AND manual_locked=0 AND status IN ('review','published')
        AND EXISTS(SELECT 1 FROM special_imports i WHERE i.id=?3 AND i.extracted_json IS ?4 AND i.candidate_json IS ?5
          AND i.review_status IN ('pending','accepted') AND NOT EXISTS(SELECT 1 FROM special_imports newer
            WHERE newer.fb_post_id=i.fb_post_id AND newer.parser_version=i.parser_version AND newer.rowid>i.rowid))`)
        .bind(e.id,e.revision,row.id,row.extracted_json,row.candidate_json,token),
      env.DB.prepare(`INSERT INTO special_event_log(event_id,source_post_id,action,detail)
        SELECT ?1,?2,'cancelled','Cancelled by a Facebook post' WHERE EXISTS(SELECT 1 FROM special_events WHERE id=?1 AND status='cancelled' AND mutation_token=?3)`)
        .bind(e.id,row.fb_post_id,token),
    ]);
    return results[0]?.meta?.changes ?? 0;
  }
  // Not automatic: logged only. The event stays as it is; staff can remove it.
  if(!matches.length && await env.DB.prepare("SELECT 1 FROM special_event_log WHERE source_post_id=?1 AND action='cancelled' LIMIT 1").bind(row.fb_post_id).first()) return 0;
  await log(env,{event_id:e?.id,source:row.fb_post_id,action:'cancellation-review',detail:hold}).run();
  return 0;
}
