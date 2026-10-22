import {deliveryWindow} from '../../src/lib/delivery.js';
import {validateCurrentDay,validateWeeklyLunch,hasWeeklyLunchEvidence} from './reconcile.js';
import {normalizeWeeklyRange} from './evidence.js';
import {parserVersionFor} from './classify.js';

export function completeDeliveryReading(d) {
  return !!d && ['available','cancelled','ambiguous','none'].includes(d.status)
    && typeof d.evidence==='string' && d.evidence.length<=600
    && typeof d.date_evidence==='string' && d.date_evidence.length<=600
    && Array.isArray(d.uncertainties) && d.uncertainties.length<=8
    && d.uncertainties.every(v=>typeof v==='string' && v.length<=300);
}

// Application-owned candidate metadata; never substitute the reread's food.
export function recoveredDeliveryReading(raw,window) {
  if (!raw || 'type' in raw || !Array.isArray(raw.offers)
    || !completeDeliveryReading(raw.delivery) || raw.day_of_week!==window.weekday
    || typeof raw.day_evidence!=='string' || raw.day_evidence.length>600
    || typeof raw.poster_evidence!=='string' || raw.poster_evidence.length>2400) return null;
  try {
    if(!validateCurrentDay({...raw,poster_evidence:`${raw.poster_evidence} ${raw.delivery.date_evidence} ${raw.delivery.evidence}`},window.weekday,window.day)) return null;
  } catch { return null; }
  return {day_of_week:raw.day_of_week,day_evidence:raw.day_evidence,
    poster_evidence:raw.poster_evidence,delivery:raw.delivery,offers:[]};
}

// A model label alone is not sufficient. Accept only a complete affirmative
// sentence with optional today, city-limit qualifier and the known lunch window.
export function deliveryEvidence(raw, window) {
  const d=raw?.delivery;
  if (!d || typeof d.evidence!=='string' || d.evidence.length>600
    || typeof d.date_evidence!=='string' || d.date_evidence.length>600
    || !Array.isArray(d.uncertainties)) return 'none';
  if (d.uncertainties.length) return 'ambiguous';
  try {
    if (!validateCurrentDay({...raw,poster_evidence:`${raw.poster_evidence ?? ''} ${d.date_evidence} ${d.evidence}`},window.weekday,window.day)) return 'none';
  } catch { return 'none'; }
  const text=d.evidence.normalize('NFKC').toLowerCase().replace(/[–—]/g,'-').replace(/\s+/g,' ').trim();
  if (d.status==='cancelled' || /\b(?:no|not|unavailable|cancelled|canceled|suspended|paused)\b/.test(text)) return 'cancelled';
  if (d.status!=='available') return d.status==='ambiguous' ? 'ambiguous' : 'none';
  return /^delivery (?:is )?available(?: today)?(?: within (?:mondovi )?city limits)?(?: (?:from )?11(?::00)?\s*(?:am)?\s*-\s*1:30\s*(?:pm)?)?[.!]?$/.test(text) ? 'available' : 'ambiguous';
}

export async function expireDelivery(env, now = new Date(Date.now())) {
  const w=deliveryWindow(now);
  await env.DB.prepare(`UPDATE delivery_automation SET active=0,observed_at=?1
    WHERE id=1 AND active=1 AND (day<>?2 OR expires_at<=?1 OR ?3=0)`)
    .bind(now.toISOString(),w.day,w.open?1:0).run();
}

export async function reconcileDelivery(env,{sourceIds,observedAt}) {
  const now=new Date(Date.now()), w=deliveryWindow(now);
  if (!w.open || deliveryWindow(new Date(observedAt)).day!==w.day) return;
  const ids=JSON.stringify(sourceIds), parser=parserVersionFor(env);
  const {results:sources}=await env.DB.prepare(`SELECT * FROM special_imports
    WHERE id IN (SELECT value FROM json_each(?1)) AND parser_version=?2`).bind(ids,parser).all();
  let available=false, blocked=sources.length!==sourceIds.length;
  for (const source of sources) {
    if (deliveryWindow(new Date(source.fb_created_time)).day!==w.day) continue;
    if (['pending','processing'].includes(source.processing_status)) {blocked=true;continue;}
    if (source.processing_status!=='staged' || source.validation_result!=='ok'
      || !source.image_r2_key || !['pending','accepted'].includes(source.review_status)) {blocked=true;continue;}
    let raw;
    try {
      raw=JSON.parse(source.extracted_json);
      const candidate=JSON.parse(source.candidate_json);
      // A resolved weekly-shape repair drops the daily-only delivery field by
      // contract. Its comparison flag is not conflicting current-day evidence.
      // Require both durable shapes, weekly headings and complete validation;
      // hybrid, unresolved, staff-excluded and unfinished sources still block.
      if (raw?.type==='weekly-lunch' && candidate?.type==='weekly-lunch'
        && hasWeeklyLunchEvidence(raw.poster_evidence) && hasWeeklyLunchEvidence(candidate.poster_evidence)
        && !['offers','day_of_week','day_evidence','delivery','unresolved_days'].some(key=>key in raw || key in candidate)) {
        validateWeeklyLunch(normalizeWeeklyRange(raw));
        validateWeeklyLunch(candidate);
        continue;
      }
      if (candidate?.delivery_blocked) {blocked=true;continue;}
      if (candidate?.delivery_recovery) {
        const recovered=recoveredDeliveryReading(candidate.delivery_recovery,w);
        if(!recovered) {blocked=true;continue;}
        raw=recovered;
      }
    } catch {blocked=true;continue;}
    const evidence=deliveryEvidence(raw,w);
    available ||= evidence==='available';
    blocked ||= evidence==='cancelled' || evidence==='ambiguous';
  }
  // Snapshot fencing includes staff review and newer versions of the same post.
  // A slower scan cannot overwrite a later cancellation or expiration.
  const writeWindow=deliveryWindow(new Date(Date.now()));
  if (!writeWindow.open || writeWindow.day!==w.day) return;
  await env.DB.prepare(`INSERT INTO delivery_automation(id,day,active,expires_at,observed_at,source_ids)
    SELECT 1,?1,?2,?3,?4,?5 WHERE NOT EXISTS(
      SELECT 1 FROM json_each(?6) j WHERE NOT EXISTS(
        SELECT 1 FROM special_imports i WHERE i.id=json_extract(j.value,'$.id')
        AND i.parser_version=?7 AND i.extracted_json IS json_extract(j.value,'$.extracted_json')
        AND i.candidate_json IS json_extract(j.value,'$.candidate_json')
        AND i.processing_status=json_extract(j.value,'$.processing_status')
        AND i.validation_result IS json_extract(j.value,'$.validation_result')
        AND i.review_status=json_extract(j.value,'$.review_status')
        AND i.fb_created_time=json_extract(j.value,'$.fb_created_time')
        AND i.image_r2_key IS json_extract(j.value,'$.image_r2_key')
        AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=i.fb_post_id
          AND newer.parser_version=i.parser_version AND newer.rowid>i.rowid)))
    ON CONFLICT(id) DO UPDATE SET day=excluded.day,active=excluded.active,
      expires_at=excluded.expires_at,observed_at=excluded.observed_at,source_ids=excluded.source_ids
    WHERE excluded.observed_at>delivery_automation.observed_at`)
    .bind(w.day,available&&!blocked?1:0,w.expiresAt,observedAt,ids,JSON.stringify(sources),parser).run();
}
