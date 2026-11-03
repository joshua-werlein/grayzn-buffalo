// Bounded alert diagnostics, built only from the verified alert snapshot and
// the reconciler's fixed reason strings. Facebook text never selects a reason,
// stage, category or link: unknown reasons collapse to a generic label, and
// stored slot text is reduced to short plain words with links removed.
// Nothing here writes, logs or affects publication.
import {deliveryWindow,resolveDeliveryDisplay,compatibleDeliveryExpiration} from '../../src/lib/delivery.js';
export const SITE = 'https://grayznbuffalo.com';
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const EDITOR_DAY_ORDER = [1,2,3,4,5,6,0]; // DAY_NUMBERS in src/lib/specials-store.ts
const SERVICES = {lunch:'Lunch','all-day':'All Day',nightly:'Nightly',custom:'Soup',soup:'Soup',unknown:'Unidentified service'};
const STAGES = {
  classification: ['Service not established by evidence','Conflicting offer service evidence','Conflicting or unresolved service evidence'],
  'offer validation': ['Missing meal price','Missing price in original meal evidence','Missing corroborating price evidence',
    'Conflicting offer price','Ambiguous offer price evidence','Ambiguous price evidence','Ambiguous service_time price',
    'Meal facts differ from original evidence','Ambiguous side alternatives','Uncertain extracted offer','Invalid offer evidence',
    'Offer exceeds 150 characters without lossless representation','Offer with recovered price exceeds 150 characters',
    'Ambiguous standalone Soup evidence','Conflicting standalone Soup evidence','Duplicate extracted offer',
    'Missing, malformed or ambiguous Wing Night prices','Missing, malformed or ambiguous printed choice prices',
    'Missing or malformed All Day prices','Missing or malformed lunch price','Missing or malformed nightly prices',
    'Missing or ambiguous single-day lunch price','Invalid poster evidence'],
  'cross-post agreement': ['Conflicting source offers','Unresolved offer could contradict this offer','Slot contested by another post',
    'Unresolved sibling could compete for this slot','Conflicting or unresolved daily source agreement','Conflicting Wednesday All Day pair'],
  'slot eligibility': ['Additional existing slots prevent replacement','Missing, disabled or ambiguous destination',
    'Invalid reserved Soup destination','Destination capacity exceeded','Ambiguous existing slot assignment'],
  'date check': ['Facebook creation timestamp is invalid, future, or outside the current Chicago date',
    'Printed weekday does not match current Chicago day','Printed calendar date does not match current Chicago date',
    'Poster references another or future date; review required','Numeric weekday does not match current Chicago day',
    'Conflicting printed weekdays in day evidence or poster heading','numeric day does not match explicit weekday evidence'],
};
const STAGE_OF = new Map(Object.entries(STAGES).flatMap(([stage,reasons])=>reasons.map(r=>[r,stage])));
const PROTECTED = 'Protected or ineligible destination slot';
const MAX_LINES = 6, MAX_VALUE = 80;
// Control, soft-hyphen, zero-width, bidirectional and line/paragraph separator
// characters, built from code points so the source holds none of them.
const INVISIBLE = new RegExp(`[${[[0x00,0x1f],[0x7f,0x9f],[0xad,0xad],[0x200b,0x200f],[0x2028,0x202e],[0x2060,0x206f],[0xfeff,0xfeff]]
  .map(([a,b])=>`${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`,'gu');

const known = reason => STAGE_OF.has(reason) ? reason : 'Other reconciliation hold';
// Plain words only: no control/bidi characters, links, addresses or markup.
export function plainValue(value, limit = MAX_VALUE) {
  let s = String(value ?? '').normalize('NFKC')
    .replace(INVISIBLE,' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/*\S*/gi,' ')
    .replace(/\S*@\S*/g,' ')
    .replace(/\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b\S*/gi,' ')
    .replace(/[^\p{L}\p{N} &,.:$'"()\/+\-–—!?#%]/gu,' ')
    .replace(/\s+/g,' ').trim();
  if (s.length > limit) s = `${s.slice(0, limit - 1).trimEnd()}…`;
  return s;
}
const chicagoTime = ms => new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'}).format(new Date(ms));

// data is the verified alert snapshot: [imports, weeks, collections, groups, slots, ...].
export function dailyAlertDetail(result, data, day, weekday) {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(weekday) || weekday<0 || weekday>6) return null;
    const [, weeks=[], collections=[], groups=[], slots=[]] = Array.isArray(data) ? data : [];
    const week = weeks.length===1 && Number.isSafeInteger(weeks[0].id) && weeks[0].id>0 ? weeks[0] : null;
    const collection = week && collections.find(c=>c.weekly_special_id===week.id && c.kind==='week');
    const todays = collection ? groups.filter(g=>g.collection_id===collection.id && g.day_of_week===weekday) : [];
    const label = service => SERVICES[service] ?? 'Other';
    const held = new Map();
    const destinations = [];
    let protectedCount = 0;
    for (const b of Array.isArray(result?.blocked) ? result.blocked : []) {
      const matching=todays.filter(g=>g.service===b.service);
      const group = todays.find(g=>g.id===b.group_id && g.service===b.service)
        ?? (b.reason==='Missing, disabled or ambiguous destination' && matching.length===1 ? matching[0] : null);
      const slot = group && slots.find(s=>s.group_id===group.id && s.position===b.position);
      const staffLocked = !!slot && slot.manual_locked===1 && !!slot.content;
      const disabled = group?.enabled===0 || (b.reason==='Missing, disabled or ambiguous destination'
        && todays.filter(g=>g.service===b.service).length===1 && todays.find(g=>g.service===b.service)?.enabled===0);
      const intentional = (b.reason===PROTECTED && staffLocked) || disabled;
      if (b?.reason===PROTECTED && staffLocked) protectedCount++;
      const reason = b.reason===PROTECTED
        ? staffLocked ? 'Staff-locked destination; existing website value retained'
          : !slot ? 'Destination slot is missing; automatic publication withheld'
          : slot.price ? 'Destination has a separate price; automatic replacement is ineligible'
          : slot.section_link ? 'Destination links to another section; automatic replacement is ineligible'
          : slot.origin==='automation' && slot.content!==slot.last_auto_value ? 'Website value differs from the last automated value; retained for review'
          : 'Destination slot is ineligible; existing website value retained'
        : disabled ? 'Staff-disabled destination; automatic publication withheld' : known(b.reason);
      destinations.push({category:label(b.service),position:Number.isSafeInteger(b.position) && b.position>0 ? b.position : null,
        proposed: b.reason===PROTECTED || STAGE_OF.has(b.reason) ? plainValue(b.content,160) : '',
        retained:slot ? plainValue(slot.content,160) : null,retainedPrice:slot?.price ? plainValue(slot.price,40) : '',staffLocked,disabled,intentional,reason});
      if (b?.reason === PROTECTED) continue;
      const key = `${label(b?.service)}|${known(b?.reason)}`;
      held.set(key, (held.get(key) ?? 0) + 1);
    }
    for (const r of Array.isArray(result?.rejectedSources) ? result.rejectedSources : []) {
      const key = `Facebook post|${known(r?.reason)}`;
      held.set(key, (held.get(key) ?? 0) + 1);
    }
    const holds = [...held].map(([key,count])=>{const [category,reason]=key.split('|');
      return {category,reason,count,stage:STAGE_OF.get(reason) ?? 'reconciliation'};}).slice(0,MAX_LINES);
    // What automation currently shows today, from the same verified snapshot.
    const published = [];
    const publishedValues = [];
    for (const g of todays.filter(g=>g.enabled===1)) {
      const n = slots.filter(s=>s.group_id===g.id && s.origin==='automation' && (s.content ?? '').trim()).length;
      if (n) published.push({category:label(g.service),count:n});
      for (const s of slots.filter(s=>s.group_id===g.id && s.origin==='automation' && (s.content??'').trim()))
        publishedValues.push({category:label(g.service),position:s.position,value:plainValue(s.content,160)});
    }
    // Current stored text only for an identified service; an unidentified
    // offer is never guessed onto a slot.
    const current = [];
    for (const category of new Set(holds.map(h=>h.category))) {
      const service = Object.keys(SERVICES).find(k=>SERVICES[k]===category && k!=='soup');
      const group = service && service!=='unknown' ? todays.find(g=>g.service===service) : null;
      if (!group) continue;
      const values = slots.filter(s=>s.group_id===group.id && (s.content ?? '').trim()).sort((a,b)=>a.position-b.position)
        .slice(0,4).map(s=>plainValue(s.content)).filter(Boolean);
      current.push({category, values, empty: !values.length});
    }
    const index = EDITOR_DAY_ORDER.indexOf(weekday);
    const reviewUrls=(data[0]??[]).filter(s=>/^[a-zA-Z0-9_-]{1,100}$/.test(s.id) && ['pending','accepted'].includes(s.review_status))
      .slice(0,6).map(s=>`${SITE}/admin/automation?date=${day}#import-${s.id}`);
    const posts=(data[0]??[]).flatMap(s=>{
      const ms=Date.parse(s.fb_created_time);
      if(!Number.isFinite(ms) || deliveryWindow(new Date(ms)).day!==day) return [];
      return [{time:chicagoTime(ms),url:/^\d{1,30}_\d{1,30}$/.test(s.fb_post_id)
        ? `https://www.facebook.com/${s.fb_post_id.split('_')[0]}/posts/${s.fb_post_id.split('_')[1]}` : null}];
    }).slice(0,MAX_LINES);
    const hasHolds=destinations.length>0 || (result?.rejectedSources?.length??0)>0;
    const informational=destinations.length>0 && destinations.every(d=>d.intentional) && !(result?.rejectedSources?.length);
    return {scope:'daily', day, weekday:DAY_NAMES[weekday], holds, protectedCount, published, current,reviewUrls,
      destinations:destinations.slice(0,MAX_LINES),publishedValues:publishedValues.slice(0,12),posts,informational,
      result:hasHolds ? published.length ? 'Partially Published' : 'Held for Review'
        : result?.requiresWrite ? 'Publication incomplete'
        : result?.reason==='No unique current saved week' ? 'Held for Review'
        : result?.reason==='No extracted evidence' ? 'Evidence unavailable'
        : published.length ? 'Published' : 'No verified publication',
      editorUrl: week ? `${SITE}/admin/specials?week=${week.id}#weekly-day-${index}` : `${SITE}/admin/specials`};
  } catch { return null; }
}

// Current visibility only. An expired row cannot establish earlier activation.
// Source text is bounded and restricted to the explicit delivery evidence field.
export function deliveryAlertDetail(data, outcome, now) {
  const w=deliveryWindow(new Date(now)),saved=data[6]?.find(s=>s.id===1);
  const manual=data[5]?.[0]?.value ?? 'auto';
  const setting=['auto','available','unavailable','hidden'].includes(manual)?manual:'invalid';
  const iso=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : '(missing or invalid)';
  const statuses=new Set(['available','cancelled','ambiguous','none','other_day','pending','ineligible','weekly','withheld']);
  const readings=outcome?.sourceOutcomes ?? data[0].filter(s=>{
    const time=Date.parse(s.fb_created_time);
    return Number.isFinite(time) && time<=now && deliveryWindow(new Date(time)).day===w.day;
  }).map(s=>({id:s.id,status:'not_reassessed'}));
  const evidence=readings.slice(0,MAX_LINES).map(s=>{
    let value='';
    try {
      const source=data[0].find(i=>i.id===s.id),candidate=JSON.parse(source.candidate_json);
      const raw=candidate?.delivery_recovery ?? JSON.parse(source.extracted_json);
      if(typeof raw?.delivery?.evidence==='string') value=plainValue(raw.delivery.evidence,160);
    } catch { /* Missing evidence is never guessed. */ }
    return {status:s.status==='not_reassessed'?'extracted; not reassessed outside delivery window':statuses.has(s.status)?s.status:'unknown',value};
  });
  return {setting,visibility:resolveDeliveryDisplay(manual,saved,new Date(now)),checkedAt:new Date(now).toISOString(),
    reconciliation:['expected','pending','withheld','hidden','expired','failed'].includes(outcome?.status)?outcome.status:'unknown',
    expectedExpiry:w.expiresAt,storedExpiry:iso(saved?.expires_at),
    mismatch:!!saved && saved.day===w.day && saved.expires_at!==w.expiresAt,
    compatible:!!saved && compatibleDeliveryExpiration(saved.expires_at,w),evidence};
}

// Weekly Lunch diagnostics: fixed reason codes from the weekly assessment.
// Weekday names, validated dates and fixed text only; no meal or AI text.
const WEEKLY_REASONS = {
  validation_rejected:'Weekly poster failed validation; no weekday meal was verified',
  import_failed:'Weekly poster could not be imported',
  retry_exhausted:'Automatic import retries were exhausted',
  ai_budget_exhausted:'The daily AI limit prevented extraction',
  invalid_evidence:'Stored weekly evidence is no longer valid',
  unverified_meal:'Meal facts could not be verified against the poster',
  source_conflict:'Weekly posters disagree for this day',
  unwritten:'Eligible meal was not written to the website',
  missing_destination:'Lunch destination is missing or ambiguous',
  ineligible:'Lunch slot is not eligible for automatic replacement',
  no_matching_week:'No unique saved week matches the printed date range',
  retained_conflict:'Website shows a different automated meal that this poster cannot replace',
};
const WEEKLY_CATEGORIES = new Set(['extraction','validation','publication']);
const isRange = v => typeof v==='string' && /^\d{1,2}\/\d{1,2}-\d{1,2}\/\d{1,2}$/.test(v);
const isDate = v => typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
export function weeklyAlertDetail({day, data, sources=[], failures=[], inspection=[]}) {
  try {
    if (!isDate(day)) return null;
    const weeks = Array.isArray(data?.[1]) ? data[1] : [];
    const known = failures.find(f=>Number.isSafeInteger(f.weekId) && f.weekId>0 && isDate(f.weekStart));
    const current = weeks.length===1 && Number.isSafeInteger(weeks[0].id) && weeks[0].id>0 ? weeks[0] : null;
    const week = known ? {id:known.weekId,start:known.weekStart} : current ? {id:current.id,start:current.week_start_date} : null;
    let range = failures.map(f=>f.dateRange).find(isRange) ?? null;
    if (!range) for (const s of sources) {
      try {
        const printed = JSON.parse(String(s.extracted_json).replace(/^```(?:json)?\n?|\n?```$/gm,'').trim())?.date_range;
        if (isRange(printed)) { range = printed; break; }
      } catch { /* No printed range is guessed. */ }
    }
    const holds = [];
    for (const f of failures) {
      if (!Object.hasOwn(WEEKLY_REASONS,f.reason) || !WEEKLY_CATEGORIES.has(f.category)) continue;
      const days = [...new Set([f.day,...(f.days??[])].filter(d=>Number.isInteger(d) && d>=1 && d<=5))].sort();
      const line = {category:f.category, reason:WEEKLY_REASONS[f.reason], days:days.map(d=>DAY_NAMES[d])};
      if (!holds.some(h=>h.category===line.category && h.reason===line.reason && h.days.join()===line.days.join())) holds.push(line);
    }
    // Weekday outcomes from the read-only weekly inspection (fixed codes only).
    const failing = new Set(failures.flatMap(f=>[f.day,...(f.days??[])]).filter(d=>Number.isInteger(d)));
    const daysWith = reasons => [...new Set((Array.isArray(inspection)?inspection:[]).flatMap(r=>(r.held??[])
      .filter(h=>reasons.includes(h.reason) && Number.isInteger(h.day) && h.day>=1 && h.day<=5 && !failing.has(h.day)).map(h=>h.day)))].sort().map(d=>DAY_NAMES[d]);
    const publishedDays = daysWith(['published']), protectedDays = daysWith(['staff_locked','disabled','staff_cleared']), retainedDays = daysWith(['retained']);
    const first = failures.map(f=>f.day ?? f.days?.[0]).find(d=>Number.isInteger(d) && d>=1 && d<=5);
    const reviewUrls = sources.filter(s=>/^[a-zA-Z0-9_-]{1,100}$/.test(s.id)).slice(0,6).map(s=>`${SITE}/admin/automation?date=${day}#import-${s.id}`);
    const posts = sources.flatMap(s=>{
      const ms=Date.parse(s.fb_created_time);
      if(!Number.isFinite(ms) || deliveryWindow(new Date(ms)).day!==day) return [];
      return [{time:chicagoTime(ms),url:/^\d{1,30}_\d{1,30}$/.test(s.fb_post_id)
        ? `https://www.facebook.com/${s.fb_post_id.split('_')[0]}/posts/${s.fb_post_id.split('_')[1]}` : null}];
    }).slice(0,MAX_LINES);
    return {scope:'weekly', day, weekday:DAY_NAMES[new Date(`${day}T12:00:00Z`).getUTCDay()],
      weekStart:week?.start ?? null, dateRange:range, categories:[...new Set(holds.map(h=>h.category))],
      weeklyHolds:holds.slice(0,MAX_LINES), posts, reviewUrls, publishedDays, protectedDays, retainedDays,
      // Partial only when a weekday is verified as published by automation now.
      result: publishedDays.length ? 'Partially Published' : 'Held for Review',
      editorUrl: week ? `${SITE}/admin/specials?week=${week.id}${first ? `#weekly-day-${EDITOR_DAY_ORDER.indexOf(first)}` : ''}` : `${SITE}/admin/specials`};
  } catch { return null; }
}
function formatWeeklyText({day, code, summary, detail:d, firstSeenMs}) {
  const lines = [`Weekly Lunch: ${summary}`, `Date: ${d.weekday}, ${day} (Chicago)`];
  if (Number.isSafeInteger(firstSeenMs) && firstSeenMs>0) lines.push(`First detected: ${chicagoTime(firstSeenMs)}`);
  lines.push(`Affected week: ${d.weekStart ? `week of ${d.weekStart}` : 'saved week not verified'}${d.dateRange ? ` (printed ${d.dateRange})` : ''}`);
  lines.push(`Result: ${d.result} (current verified snapshot)`);
  lines.push(`Failure category: ${d.categories.length ? d.categories.join(', ') : STAGE_FOR_CODE[code] ?? 'publication'}`);
  for (const post of d.posts) lines.push(`Facebook posted: ${day}, ${post.time} (Chicago)${post.url ? ` — ${post.url}` : ''}`);
  if (d.weeklyHolds.length) {
    lines.push('', 'Held:');
    for (const h of d.weeklyHolds) lines.push(`- ${h.days.length ? h.days.join(', ') : 'Weekly poster'}: ${h.reason}`);
  }
  lines.push('', `Published by automation: ${d.publishedDays?.length ? d.publishedDays.join(', ') : 'none verified'}`);
  if (d.protectedDays?.length) lines.push(`Staff-protected (kept, not a failure): ${d.protectedDays.join(', ')}`);
  if (d.retainedDays?.length) lines.push(`Daily poster value kept (precedence, not a failure): ${d.retainedDays.join(', ')}`);
  lines.push('', 'Daily specials publication does not establish Weekly Lunch publication.');
  lines.push('', `Automatic retry: ${RETRY[code] ?? 'none pending'}`);
  lines.push('Correction: needed for Weekly Lunch. Review the held weekly import and enter or approve the weekday lunches; staff-entered values are protected from automation.');
  lines.push(`Open: ${d.editorUrl}`, `Review imports: ${SITE}/admin/automation?date=${day}`);
  for (const url of d.reviewUrls) if (new RegExp(`^${SITE.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/admin/automation\\?date=${day}#import-[a-zA-Z0-9_-]{1,100}$`).test(url)) lines.push(`Pending import: ${url}`);
  return lines.join('\n');
}

const RETRY = {retry_exhausted:'exhausted',ai_budget_exhausted:'paused until the daily AI limit resets'};
const STAGE_FOR_CODE = {import_failed:'import',validation_rejected:'validation',ai_budget_exhausted:'AI extraction',
  retry_exhausted:'import retries',delivery_failed:'delivery activation',automation_failed:'automation run'};

// Plain-text body only. Every interpolated value is either fixed text, a
// validated number/date, or plainValue() output.
export function formatAlertText({day, code, summary, detail, firstSeenMs}) {
  const d = detail && detail.day===day ? detail : null;
  if (d?.scope==='weekly') return formatWeeklyText({day, code, summary, detail:d, firstSeenMs});
  const lines = [summary];
  lines.push(`Date: ${d ? `${d.weekday}, ` : ''}${day} (Chicago)`);
  if (Number.isSafeInteger(firstSeenMs) && firstSeenMs>0) lines.push(`First detected: ${chicagoTime(firstSeenMs)}`);
  if(d?.result) lines.push(`Result: ${d.result} (current verified snapshot)`);
  if(d?.informational) lines.push('Classification: informational staff protection; AI extraction did not fail.');
  for(const post of d?.posts??[]) lines.push(`Facebook posted: ${day}, ${post.time} (Chicago)${post.url ? ` — ${post.url}` : ''}`);
  const stages = d?.holds?.length ? [...new Set(d.holds.map(h=>h.stage))].join(', ') : STAGE_FOR_CODE[code] ?? 'publication';
  lines.push(`Stage: ${stages}`);
  if (d?.holds?.length) {
    lines.push('', 'Held:');
    for (const h of d.holds) lines.push(`- ${h.category}: ${h.count} ${h.count===1?'item':'items'}, ${h.reason}`);
    if (d.holds.some(h=>h.category==='Unidentified service'))
      lines.push('  (The service could not be identified, so no slot is named.)');
  }
  if (d?.protectedCount) lines.push(`Staff-protected values kept: ${d.protectedCount}`);
  for(const h of d?.destinations??[]) {
    lines.push(`Destination: ${d.weekday} ${h.category}${h.position ? ` #${h.position}` : ' (slot unverified)'}`,
      `Reason: ${h.reason}`,`Staff lock: ${h.staffLocked?'yes':'no verified lock'}; disabled: ${h.disabled?'yes':'no verified disabled destination'}`);
    if(h.proposed) lines.push(`Facebook proposed: ${h.proposed}`);
    if(h.retained!==null) lines.push(`Website retained: ${h.retained || '(blank)'}`);
    if(h.retainedPrice) lines.push(`Website separate price: ${h.retainedPrice}`);
  }
  if (d?.scope==='daily') lines.push('', `Published by automation today: ${d.published?.length ? d.published.map(p=>`${p.category} (${p.count})`).join(', ') : 'none'}`);
  for (const c of d?.current ?? []) lines.push(`Now showing for ${c.category}: ${c.empty ? '(blank)' : c.values.join(' | ')}`);
  for(const p of d?.publishedValues??[]) lines.push(`Published value: ${d.weekday} ${p.category} #${p.position}: ${p.value}`);
  if(d?.delivery) {
    const v=d.delivery;
    lines.push('',`Delivery setting: ${v.setting}; reconciliation: ${v.reconciliation}`,
      `Delivery visibility at ${v.checkedAt}: ${v.visibility}`,
      `Delivery expiration: expected ${v.expectedExpiry}; stored ${v.storedExpiry}`);
    if(v.mismatch) lines.push(`Delivery expiration mismatch: ${v.compatible?'recognized legacy deadline; rendering still ends at 1:30 PM Chicago':'unrecognized deadline; automatic rendering fails closed'}.`);
    for(const e of v.evidence) lines.push(`Delivery evidence (${e.status}): ${e.value || '(not available)'}`);
    if(v.reconciliation==='expired') lines.push('Delivery window has ended; this snapshot does not establish whether delivery was active earlier.');
  }
  lines.push('', `Automatic retry: ${RETRY[code] ?? 'none pending'}`);
  if (code==='delivery_failed') {
    lines.push('Correction: check the Delivery display setting.', `Open: ${SITE}/admin#delivery-display`);
  } else if(d?.informational) {
    lines.push('Staff action: optional. The staff-entered value or disabled destination was preserved. Review only if you want to change that choice.',`Open: ${d.editorUrl}`);
  } else {
    lines.push(`Correction: needed${d ? ` for ${d.weekday}` : ''}. Review the held imports and use Approve & Publish; approved values are protected from automation. The specials editor is also available.`);
    lines.push(`Open: ${d?.editorUrl ?? `${SITE}/admin/specials`}`);
  }
  if (code!=='delivery_failed' && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    lines.push(`Review imports: ${SITE}/admin/automation?date=${day}`);
    for(const url of d?.reviewUrls??[]) if(new RegExp(`^${SITE.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/admin/automation\\?date=${day}#import-[a-zA-Z0-9_-]{1,100}$`).test(url)) lines.push(`Pending import: ${url}`);
  }
  return lines.join('\n');
}
export function alertSubjectSuffix(detail) {
  if (detail?.scope==='weekly') return ' (Weekly Lunch)';
  const categories = [...new Set((detail?.holds ?? []).map(h=>h.category))].slice(0,3);
  return categories.length ? ` (${categories.join(', ')})` : '';
}
