import { chicagoCalendarDate, isIsoCalendarDate, mondayForIsoDate, calendarDayOfWeek, calendarDatesFrom } from './weekly-specials';
import { visibleGroups, displayedSpecial, DAY_NAMES } from './specials-store';
import { mexicanNightDetailVisible } from './mexican-night-visibility.js';
import { chicagoMidnight } from './analytics';
import { eventState } from './special-events';
import { plainValue } from '../../workers/fb-feed/alert-detail.js';
import { applySharedWeeklyLunchPrice, validateWeeklyLunch } from '../../workers/fb-feed/reconcile.js';
import { normalizeWeeklyRange, factKey } from '../../workers/fb-feed/evidence.js';
import {approvalEvents} from '../../workers/fb-feed/staff-review.js';

const MAX_IMPORTS = 30, MAX_JSON = 24000;
// Facebook stores offsets as +0000; SQLite date functions only accept +00:00, Z or no offset.
const SQL_CREATED = `CASE WHEN fb_created_time GLOB '????-??-??[T ]??:??:??*[+-][0-9][0-9][0-9][0-9]'
  THEN substr(fb_created_time,1,length(fb_created_time)-2)||':'||substr(fb_created_time,-2) ELSE fb_created_time END`;
export const reviewText = (value: unknown, max = 180): string => plainValue(typeof value === 'string' ? value : '', max);
export function reviewTimestamp(value: unknown): string {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value)) return '';
  const iso=value.replace(' ','T') + (/Z$|[+-]\d{2}:?\d{2}$/.test(value)?'':'Z');
  const time=new Date(iso);
  return Number.isFinite(time.getTime())?time.toISOString().slice(0,19).replace('T',' '):'';
}
export function reviewServiceTime(value: unknown): string {
  return typeof value==='string' && value.length<=80 && /^[\d\sAPMapm:.–—-]+$/.test(value) ? value : reviewText(value,80);
}
export function reviewDate(input: string | null, now = new Date()): string {
  const day = input ?? chicagoCalendarDate(now);
  const today = chicagoCalendarDate(now);
  if (!isIsoCalendarDate(day)) throw Error('Choose a valid date within the last 30 days.');
  const days = Math.round((Date.parse(today + 'T12:00:00Z') - Date.parse(day + 'T12:00:00Z')) / 86400000);
  if (days < 0 || days > 29) throw Error('Choose a valid date within the last 30 days.');
  return day;
}
export function parseReviewEvidence(value: unknown): any {
  if (typeof value !== 'string' || value.length > MAX_JSON) return null;
  try { const parsed = JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g, '')); return parsed && typeof parsed === 'object' ? parsed : null; }
  catch { return null; }
}
export function facebookLink(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || !['facebook.com','www.facebook.com','m.facebook.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    url.search = ''; url.hash = ''; return url.href;
  } catch { return null; }
}
export function reviewReason(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  if(text.startsWith('STAFF_APPROVAL:')) return 'Staff-confirmed publication; approved values and prior values are retained in the import audit.';
  if (text.startsWith('GUARDED_AUTO_CONFLICT:')) {
    const reasons = new Map<string,number>();
    for (const match of text.slice(0,6000).matchAll(/"reason"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
      try { const reason=reviewText(JSON.parse(match[1]),180); if(reason) reasons.set(reason,(reasons.get(reason)??0)+1); } catch { /* Truncated historical audit. */ }
    }
    return reasons.size ? [...reasons].slice(0,8).map(([reason,count])=>`${reason} (${count} ${count===1?'item':'items'})`).join('; ')
      : 'Publication held; complete reconciliation detail is unavailable.';
  }
  return reviewText(text,600);
}
export function importOutcome(source: any, events: any[]) {
  const approvals=approvalEvents(events);
  if(approvals.some((a: any)=>a.complete)) return {status:'Staff Approved',reason:'Approved and published by staff. Saved destinations are protected from automation.'};
  if(approvals.length) return {status:'Partially Staff Approved',reason:'Selected offers were published and protected. Remaining offers still need review.'};
  const raw=parseReviewEvidence(source.extracted_json)??parseReviewEvidence(source.candidate_json);
  if(['mexican-night','weekly-lunch'].includes(raw?.type)) events=events.filter(e=>!/^GUARDED_AUTO(?::|_CONFLICT:)/.test(e.detail??''));
  const latest = events.find(e => e.event_type === 'review');
  const detail = typeof latest?.detail === 'string' ? latest.detail : '';
  const publication = events.find(e => e.event_type === 'review' && /^GUARDED_(?:AUTO|WEEKLY_LUNCH|MEXICAN_NIGHT):/.test(e.detail));
  const count = Number(publication?.detail?.match(/; (\d+) (?:slot|item)\(s\)/)?.[1] ?? 0);
  const conflict = /CONFLICT|blocked proposals|no publication/i.test(detail);
  const status = conflict ? (count > 0 ? 'Partially Published' : 'Held') : count > 0 ? 'Published'
    : source.processing_status === 'failed' ? 'Failed'
    : source.validation_result === 'rejected' ? 'Held'
    : ['pending','processing'].includes(source.processing_status) ? 'Processing' : 'Staged — publication unconfirmed';
  return {status, reason: reviewReason(detail || source.validation_reason || source.classification_reason) || 'No publication audit is available.'};
}
function sourceDate(value: unknown): string | null {
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? chicagoCalendarDate(date) : null;
}
function weeklyMatches(raw: any, source: any, week: any): boolean {
  if (!week) return false;
  const day = sourceDate(source.fb_created_time);
  if (!day) return false;
  if (!raw.date_range) return mondayForIsoDate(day) === week.week_start_date;
  const match = /^(\d{1,2})\/(\d{1,2})-(\d{1,2})\/(\d{1,2})$/.exec(raw.date_range);
  if (!match || calendarDayOfWeek(week.week_start_date) !== 1) return false;
  const friday = calendarDatesFrom(week.week_start_date, 5)[4];
  const year = Number(week.week_start_date.slice(0,4)), sourceYear = Number(day.slice(0,4));
  return [sourceYear,sourceYear+1].includes(year) && Number(week.week_start_date.slice(5,7)) === +match[1]
    && Number(week.week_start_date.slice(8)) === +match[2] && Number(friday.slice(5,7)) === +match[3] && Number(friday.slice(8)) === +match[4];
}
export function extractedForDay(source: any, day: string, week: any) {
  const raw = parseReviewEvidence(source.candidate_json) ?? parseReviewEvidence(source.extracted_json);
  if (!raw) return {values: [] as string[], scope: 'Missing or malformed extraction', relevant: sourceDate(source.fb_created_time) === day};
  if (raw.type === 'weekly-lunch') {
    if (!weeklyMatches(raw,source,week)) return {values: [], scope: 'Weekly date association unavailable', relevant: sourceDate(source.fb_created_time) === day};
    try {
      const weekly = applySharedWeeklyLunchPrice(validateWeeklyLunch(normalizeWeeklyRange(raw)));
      return {values: weekly.entries.filter((e: any) => e.day_of_week === calendarDayOfWeek(day)).map((e: any) => reviewText(e.content)), scope: 'Weekly Lunch', relevant: true};
    } catch { return {values: [], scope: 'Malformed weekly extraction', relevant: true}; }
  }
  if (raw.type === 'mexican-night') return {values: Array.isArray(raw.groups) ? raw.groups.slice(0,12).flatMap((g: any) => Array.isArray(g?.items) ? g.items.slice(0,4).map((i: any) => reviewText([i?.title,i?.description].filter(v => typeof v === 'string').join(' '))) : []) : [], scope: 'Mexican Night', relevant: sourceDate(source.fb_created_time) === day};
  const values = Array.isArray(raw.offers) ? raw.offers.slice(0,20).map((o: any) => reviewText(o?.content))
    : Array.isArray(raw) ? raw.slice(0,12).filter((g: any) => g?.day_of_week === calendarDayOfWeek(day)).flatMap((g: any) => Array.isArray(g.items) ? g.items.slice(0,4).map((i: any) => reviewText([i?.content,i?.price].filter(v => typeof v === 'string').join(' '))) : []) : [];
  return {values: values.filter(Boolean), scope: 'Daily evidence — compare by service below', relevant: sourceDate(source.fb_created_time) === day};
}
export function protectedValue(slot: any): string {
  if (slot.manual_locked === 1) return 'Yes — staff locked';
  if (slot.price || slot.section_link) return 'Yes — separate price or section link';
  if (slot.origin === 'automation' && slot.last_auto_value !== slot.content) return 'Yes — changed since automation';
  if (!slot.content || slot.origin === 'automation' || slot.origin === 'manual') return 'No staff lock; other publication safeguards still apply';
  return 'Yes — existing legacy value';
}
export async function readAutomationReview(env: any, day: string, now = new Date()) {
  reviewDate(day, now);
  const query = async (sql: string, ...args: any[]) => (await env.DB.prepare(sql).bind(...args).all()).results ?? [];
  const from = new Date(mondayForIsoDate(day) + 'T12:00:00Z'); from.setUTCDate(from.getUTCDate()-1);
  const until = calendarDatesFrom(day,2)[1];
  const imports = await query(`SELECT id,fb_post_id,fb_created_time,fetched_at,processed_at,permalink_url,target_collection_id,
    processing_status,review_status,validation_result,substr(validation_reason,1,600) validation_reason,substr(classification_reason,1,600) classification_reason,
    CASE WHEN length(candidate_json)<=24000 THEN candidate_json END candidate_json,
    CASE WHEN length(extracted_json)<=24000 THEN extracted_json END extracted_json
    FROM special_imports WHERE julianday(${SQL_CREATED})>=julianday(?1) AND julianday(${SQL_CREATED})<julianday(?2) ORDER BY fetched_at DESC,id DESC LIMIT 31`,new Date(chicagoMidnight(from.toISOString().slice(0,10))).toISOString(),new Date(chicagoMidnight(until)).toISOString());
  const selected = imports.slice(0,MAX_IMPORTS);
  const ids = JSON.stringify(selected.map((i: any) => i.id));
  const events = await query(`SELECT e.id,e.import_id,e.event_type,
    CASE WHEN e.detail LIKE 'STAFF_APPROVAL:%' THEN 'STAFF_APPROVAL:'||json_object('version',1,'complete',json_extract(substr(e.detail,16),'$.complete'),'rows',json('[]'))
    ELSE substr(e.detail,1,6000) END detail,e.occurred_at
    FROM special_import_events e WHERE e.import_id IN (SELECT value FROM json_each(?1))
    AND e.id IN (SELECT h.id FROM special_import_events h WHERE h.import_id=e.import_id ORDER BY h.id DESC LIMIT 8)
    ORDER BY e.id DESC LIMIT 240`,ids);
  const weeks = await query(`SELECT w.id,w.week_start_date,w.week_end_date,c.id collection_id FROM weekly_specials w
    JOIN special_collections c ON c.weekly_special_id=w.id AND c.kind='week'
    WHERE w.week_start_date<=?1 AND w.week_end_date>=?1 ORDER BY w.id LIMIT 2`,day);
  const week = weeks.length === 1 ? weeks[0] : null;
  const collections = await query("SELECT id,updated_at FROM special_collections WHERE id='mexican-night' LIMIT 1");
  const collectionIds = JSON.stringify([...(week ? [week.collection_id] : []),...collections.map((c: any)=>c.id)]);
  const groups = await query(`SELECT id,collection_id,day_of_week,service,label,service_time,sort,enabled FROM special_groups
    WHERE collection_id IN (SELECT value FROM json_each(?1)) AND (collection_id='mexican-night' OR day_of_week=?2)
    ORDER BY sort,id LIMIT 65`,collectionIds,calendarDayOfWeek(day));
  if (groups.length > 64) throw Error('Too many saved groups to compare safely.');
  const slots = await query(`SELECT s.* FROM special_slots s WHERE s.group_id IN (SELECT value FROM json_each(?1)) ORDER BY s.group_id,s.position LIMIT 257`,JSON.stringify(groups.map((g: any)=>g.id)));
  if (slots.length > 256) throw Error('Too many saved values to compare safely.');
  const withSlots = groups.map((g: any)=>({...g,slots:slots.filter((s: any)=>s.group_id===g.id)}));
  const publicGroups = visibleGroups(withSlots.filter((g: any)=>g.collection_id===week?.collection_id));
  const currentGroups = withSlots.map((g: any)=>({...g,label:reviewText(g.label),time:reviewServiceTime(g.service_time),
    visibility:g.collection_id==='mexican-night' ? (mexicanNightDetailVisible(collections[0]?.updated_at,now) ? 'Visible in the current Mexican Night publication window' : 'Saved; outside the current Mexican Night publication window')
      : !g.enabled ? 'Saved; group disabled' : !publicGroups.some(p=>p.id===g.id) ? 'Saved; empty or suppressed as a duplicate'
      : day < chicagoCalendarDate(now) ? 'Historical saved values; this date is no longer on the public board'
      : 'Listed on the specials board; homepage uses today’s date. Service hours are shown, not a timed approval gate.',
    slots:g.slots.filter((s: any)=>(s.content??'').trim() || s.price).map((s: any)=>({position:s.position,value:reviewText(displayedSpecial(s)),visibility:g.collection_id==='mexican-night' ? (g.enabled===1 && mexicanNightDetailVisible(collections[0]?.updated_at,now)?'Shown in the current Mexican Night window':'Saved; not currently shown') : day<chicagoCalendarDate(now)?'Historical date; not currently shown':publicGroups.some(p=>p.id===g.id && p.slots.some(v=>v.position===s.position))?'Shown on the specials board':'Saved; not shown (disabled or suppressed duplicate)',owner:s.origin==='automation'?'Automation':s.manual_locked===1?'Staff corrected':s.origin==='manual'?'Recurring default':'Legacy',protection:protectedValue(s)}))}));
  let specialEvents: any[] = [], eventsUnavailable = false;
  try {
    specialEvents = await query(`SELECT id,title,event_date,end_time,status,origin,manual_locked,source_import_id,source_post_id,review_reason
      FROM special_events WHERE event_date=?1 ORDER BY id LIMIT 21`,day);
    if(specialEvents.length>20) throw Error('Event limit');
    const offers = await query(`SELECT event_id,content FROM special_event_offers WHERE event_id IN (SELECT value FROM json_each(?1)) ORDER BY event_id,position LIMIT 80`,JSON.stringify(specialEvents.map(e=>e.id)));
    specialEvents = specialEvents.map(e=>({...e,title:reviewText(e.title),reason:reviewText(e.review_reason,600),values:offers.filter((o: any)=>o.event_id===e.id).map((o: any)=>reviewText(o.content)),visibility:e.status==='published' && eventState(e,now)!=='expired'?'Visible on the public site':'Saved; not currently visible',editor:'/admin/specials#special-events'}));
  } catch { eventsUnavailable=true; specialEvents=[]; }
  const editor = week ? `/admin/specials?week=${week.id}#weekly-day-${[1,2,3,4,5,6,0].indexOf(calendarDayOfWeek(day))}` : '/admin/specials';
  const history = selected.map((source: any)=>{
    const extracted=extractedForDay(source,day,week), audit=events.filter((e: any)=>e.import_id===source.id);
    const linkedEvents=specialEvents.filter(e=>e.source_import_id===source.id);
    const website=extracted.scope==='Mexican Night' ? currentGroups.filter((g: any)=>g.collection_id==='mexican-night')
      : currentGroups.filter((g: any)=>g.collection_id===week?.collection_id && (extracted.scope!=='Weekly Lunch' || g.service==='lunch'));
    const current = linkedEvents.length ? linkedEvents.flatMap(e=>e.values) : website.flatMap((g: any)=>g.slots.map((s: any)=>s.value));
    return {id:source.id,source:reviewText(source.fb_post_id,90),created:reviewTimestamp(source.fb_created_time),fetched:reviewTimestamp(source.fetched_at),processed:reviewTimestamp(source.processed_at),link:facebookLink(source.permalink_url),...extracted,...importOutcome(source,audit),
      values:extracted.values.map((value: string)=>({value,comparison:current.some((v: string)=>factKey(v)===factKey(value))?'Matching saved text — comparison only':'No identical saved text — comparison only; matching is not required to replace an unlocked recurring default'})),
      editor:linkedEvents.length?'/admin/specials#special-events':extracted.scope==='Mexican Night'?'/admin/specials#mexican-form':editor,
      audits:audit.slice(0,4).map((e: any)=>({type:reviewText(e.event_type,30),at:reviewTimestamp(e.occurred_at),detail:reviewReason(e.detail)})),
      relevant:extracted.relevant || linkedEvents.length>0};
  }).filter((i: any)=>i.relevant);
  return {day,dayName:DAY_NAMES[calendarDayOfWeek(day)],editor,history,groups:currentGroups,specialEvents,eventsUnavailable,truncated:imports.length>MAX_IMPORTS,ambiguousWeek:weeks.length>1};
}
