// Bounded alert diagnostics, built only from the verified alert snapshot and
// the reconciler's fixed reason strings. Facebook text never selects a reason,
// stage, category or link: unknown reasons collapse to a generic label, and
// stored slot text is reduced to short plain words with links removed.
// Nothing here writes, logs or affects publication.
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
    .replace(/[^\p{L}\p{N} &,.$'"()\/+\-–—!?#%]/gu,' ')
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
    let protectedCount = 0;
    for (const b of Array.isArray(result?.blocked) ? result.blocked : []) {
      if (b?.reason === PROTECTED) { protectedCount++; continue; }
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
    for (const g of todays.filter(g=>g.enabled===1)) {
      const n = slots.filter(s=>s.group_id===g.id && s.origin==='automation' && (s.content ?? '').trim()).length;
      if (n) published.push({category:label(g.service),count:n});
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
    return {scope:'daily', day, weekday:DAY_NAMES[weekday], holds, protectedCount, published, current,reviewUrls,
      editorUrl: week ? `${SITE}/admin/specials?week=${week.id}#weekly-day-${index}` : `${SITE}/admin/specials`};
  } catch { return null; }
}

const RETRY = {retry_exhausted:'exhausted',ai_budget_exhausted:'paused until the daily AI limit resets'};
const STAGE_FOR_CODE = {import_failed:'import',validation_rejected:'validation',ai_budget_exhausted:'AI extraction',
  retry_exhausted:'import retries',delivery_failed:'delivery activation',automation_failed:'automation run'};

// Plain-text body only. Every interpolated value is either fixed text, a
// validated number/date, or plainValue() output.
export function formatAlertText({day, code, summary, detail, firstSeenMs}) {
  const lines = [summary];
  const d = detail && detail.day===day ? detail : null;
  lines.push(`Date: ${d ? `${d.weekday}, ` : ''}${day} (Chicago)`);
  if (Number.isSafeInteger(firstSeenMs) && firstSeenMs>0) lines.push(`First detected: ${chicagoTime(firstSeenMs)}`);
  const stages = d?.holds?.length ? [...new Set(d.holds.map(h=>h.stage))].join(', ') : STAGE_FOR_CODE[code] ?? 'publication';
  lines.push(`Stage: ${stages}`);
  if (d?.holds?.length) {
    lines.push('', 'Held:');
    for (const h of d.holds) lines.push(`- ${h.category}: ${h.count} ${h.count===1?'item':'items'}, ${h.reason}`);
    if (d.holds.some(h=>h.category==='Unidentified service'))
      lines.push('  (The service could not be identified, so no slot is named.)');
  }
  if (d?.protectedCount) lines.push(`Staff-protected values kept: ${d.protectedCount}`);
  if (d) lines.push('', `Published by automation today: ${d.published.length ? d.published.map(p=>`${p.category} (${p.count})`).join(', ') : 'none'}`);
  for (const c of d?.current ?? []) lines.push(`Now showing for ${c.category}: ${c.empty ? '(blank)' : c.values.join(' | ')}`);
  lines.push('', `Automatic retry: ${RETRY[code] ?? 'none pending'}`);
  if (code==='delivery_failed') {
    lines.push('Correction: check the Delivery display setting.', `Open: ${SITE}/admin#delivery-display`);
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
  const categories = [...new Set((detail?.holds ?? []).map(h=>h.category))].slice(0,3);
  return categories.length ? ` (${categories.join(', ')})` : '';
}
