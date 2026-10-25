// Special events (game days, holidays, one-time promotions): public reads and
// staff writes. Events are separate from weekly specials and never appear in a
// day's specials card. Expiry is computed when read; nothing is deleted on a
// schedule. Every staff write is fenced by the event's revision and token.
import { BUSINESS_TIME_ZONE, chicagoCalendarDate, isIsoCalendarDate } from './weekly-specials';
import { analyzeDailyEvidence } from '../../workers/fb-feed/evidence.js';
import { resolveEventDate, chicagoDateOf } from '../../workers/fb-feed/events.js';

export const EVENT_TITLE_LIMIT = 80;
export const EVENT_TIME_LIMIT = 80;
export const EVENT_DETAILS_LIMIT = 300;
export const EVENT_OFFER_LIMIT = 150;
export const EVENT_OFFER_COUNT = 4;
// Public pages show today and the next six days; later events wait.
export const EVENT_WINDOW_DAYS = 7;
const EXPIRED_HISTORY_DAYS = 60;

export type EventStatus = 'review' | 'published' | 'disabled' | 'rejected' | 'cancelled';
export type SpecialEvent = {
  id: string; title: string; event_date: string; time_text: string; start_time: string | null; end_time: string | null;
  details: string; status: EventStatus; origin: 'manual' | 'automation'; manual_locked: number; date_basis: string;
  source_post_id: string | null; source_permalink: string; source_created_time: string | null; evidence_json: string | null;
  last_auto_json: string | null; review_reason: string; revision: number; updated_at: string; offers: string[];
};
export type EventInput = { title: string; event_date: string; time_text: string; start_time: string | null; end_time: string | null; details: string; offers: string[] };
export class EventConflict extends Error {
  constructor() { super('This event changed after you opened it. Your edits are shown below; reload to compare before saving again.'); }
}

const clockFormatter = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Chicago wall-clock "HH:MM"; daylight-saving safe (no fixed UTC offsets). */
export function chicagoClock(now = new Date()): string {
  const parts = Object.fromEntries(clockFormatter.formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
}
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** Without an end time an event lasts through its Chicago calendar day. */
export function eventState(event: Pick<SpecialEvent, 'event_date' | 'end_time'>, now = new Date()): 'upcoming' | 'active' | 'expired' {
  const today = chicagoCalendarDate(now);
  if (event.event_date < today) return 'expired';
  if (event.event_date > today) return 'upcoming';
  return event.end_time && chicagoClock(now) >= event.end_time ? 'expired' : 'active';
}

async function withOffers(env: any, events: any[]): Promise<SpecialEvent[]> {
  if (!events.length) return [];
  const { results: offers } = await env.DB.prepare('SELECT event_id,position,content FROM special_event_offers WHERE event_id IN (SELECT value FROM json_each(?1)) ORDER BY event_id,position')
    .bind(JSON.stringify(events.map(e => e.id))).all();
  return events.map(e => ({ ...e, offers: (offers ?? []).filter((o: any) => o.event_id === e.id).map((o: any) => o.content) }));
}
const byDateAndTime = (a: SpecialEvent, b: SpecialEvent) => a.event_date.localeCompare(b.event_date)
  || (a.start_time ?? '').localeCompare(b.start_time ?? '') || a.title.localeCompare(b.title);

/** Published, unexpired events from today through the next six days. A missing
 *  table or database means no events, never a page error. */
export async function readVisibleEvents(env: any, now = new Date()): Promise<SpecialEvent[]> {
  try {
    const today = chicagoCalendarDate(now);
    const { results } = await env.DB.prepare(`SELECT * FROM special_events WHERE status='published'
      AND event_date>=?1 AND event_date<=?2 ORDER BY event_date,start_time,title`).bind(today, addDays(today, EVENT_WINDOW_DAYS - 1)).all();
    return (await withOffers(env, results ?? [])).filter(e => e.offers.length && eventState(e, now) !== 'expired').sort(byDateAndTime);
  } catch { return []; }
}

// ── Display helpers ──
const PRICE = /(?<![\w$.,])\$\s*(?:\d+(?:\.\d{2})?|\.\d{2})(?![\w.,])/g;
/** Split one trailing printed price for the price column; anything else stays inline. */
export function splitTrailingPrice(content: string): { text: string; price: string } {
  const prices = [...content.matchAll(PRICE)];
  const match = /^(.*?)[\s–—-]*(\$\s*(?:\d+(?:\.\d{2})?|\.\d{2}))\s*$/s.exec(content);
  if (prices.length !== 1 || !match || !match[1].trim()) return { text: content, price: '' };
  return { text: match[1].trim(), price: match[2].replace(/\s+/g, '') };
}
export const formatEventDate = (date: string, style: 'short' | 'long' = 'short') => new Intl.DateTimeFormat('en-US',
  style === 'long' ? { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' } : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${date}T12:00:00Z`));
const clockLabel = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
};
export function formatEventTime(event: Pick<SpecialEvent, 'time_text' | 'start_time' | 'end_time'>): string {
  if (event.start_time && event.end_time) return `${clockLabel(event.start_time)}–${clockLabel(event.end_time)}`;
  if (event.start_time) return `From ${clockLabel(event.start_time)}`;
  if (event.end_time) return `Until ${clockLabel(event.end_time)}`;
  return event.time_text;
}

// ── Staff administration ──
export type AdminEvents = { review: SpecialEvent[]; current: SpecialEvent[]; inactive: SpecialEvent[]; expired: SpecialEvent[] };
export async function readAdminEvents(env: any, now = new Date()): Promise<AdminEvents> {
  const since = addDays(chicagoCalendarDate(now), -EXPIRED_HISTORY_DAYS);
  const { results } = await env.DB.prepare('SELECT * FROM special_events WHERE event_date>=?1 ORDER BY event_date,start_time,title').bind(since).all();
  const events = await withOffers(env, results ?? []);
  const live = (e: SpecialEvent) => eventState(e, now) !== 'expired';
  return {
    review: events.filter(e => e.status === 'review' && live(e)),
    current: events.filter(e => e.status === 'published' && live(e)),
    inactive: events.filter(e => ['disabled', 'rejected', 'cancelled'].includes(e.status) && live(e)),
    expired: events.filter(e => !live(e)).reverse(),
  };
}
export async function readEvent(env: any, id: string): Promise<SpecialEvent | null> {
  if (!/^evt:[\w-]{1,64}$/.test(id)) return null;
  const row = await env.DB.prepare('SELECT * FROM special_events WHERE id=?1').bind(id).first();
  return row ? (await withOffers(env, [row]))[0] : null;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const text = (form: FormData, name: string) => String(form.get(name) ?? '').replace(/\r\n?/g, '\n').trim();
/** Submitted values for redisplay after a validation error (never saved). */
export function eventDraftFromForm(form: FormData): EventInput {
  const clip = (name: string, limit: number) => text(form, name).slice(0, limit);
  return { title: clip('title', EVENT_TITLE_LIMIT), event_date: clip('event_date', 10), time_text: clip('time_text', EVENT_TIME_LIMIT),
    start_time: clip('start_time', 5) || null, end_time: clip('end_time', 5) || null, details: clip('details', EVENT_DETAILS_LIMIT),
    offers: Array.from({ length: EVENT_OFFER_COUNT }, (_, i) => clip(`offer_${i + 1}`, EVENT_OFFER_LIMIT)) };
}
/** Server-side validation of every staff-submitted field; never trusts client limits. */
export function eventInputFromForm(form: FormData): EventInput {
  const title = text(form, 'title').replace(/\s+/g, ' ');
  const event_date = text(form, 'event_date');
  const time_text = text(form, 'time_text').replace(/\s+/g, ' ');
  const details = text(form, 'details');
  const start_time = text(form, 'start_time') || null, end_time = text(form, 'end_time') || null;
  const offers = Array.from({ length: EVENT_OFFER_COUNT }, (_, i) => text(form, `offer_${i + 1}`)).filter(Boolean);
  if (!title) throw new Error('Enter an event name.');
  if (title.length > EVENT_TITLE_LIMIT) throw new Error(`The event name allows ${EVENT_TITLE_LIMIT} characters.`);
  if (!isIsoCalendarDate(event_date)) throw new Error('Choose a valid event date.');
  if (time_text.length > EVENT_TIME_LIMIT) throw new Error(`The time label allows ${EVENT_TIME_LIMIT} characters.`);
  if (details.length > EVENT_DETAILS_LIMIT) throw new Error(`Details allow ${EVENT_DETAILS_LIMIT} characters.`);
  if ((start_time && !TIME.test(start_time)) || (end_time && !TIME.test(end_time))) throw new Error('Enter start and end times as HH:MM.');
  if (start_time && end_time && end_time <= start_time) throw new Error('The end time must be after the start time on the same day.');
  if (!offers.length) throw new Error('Enter at least one offer, including its price.');
  if (offers.some(o => o.length > EVENT_OFFER_LIMIT)) throw new Error(`Each offer, including its price, allows ${EVENT_OFFER_LIMIT} characters.`);
  return { title, event_date, time_text, start_time, end_time, details, offers };
}

const prepare = (env: any, sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args);
function offerStatements(env: any, id: string, offers: string[], gate: string, ...gateArgs: unknown[]) {
  return [prepare(env, `DELETE FROM special_event_offers WHERE event_id=?1 AND ${gate}`, id, ...gateArgs),
    ...offers.map((content, i) => prepare(env, `INSERT INTO special_event_offers(event_id,position,content) SELECT ?1,?${gateArgs.length + 2},?${gateArgs.length + 3} WHERE ${gate}`, id, ...gateArgs, i + 1, content))];
}
const tokenGate = 'EXISTS(SELECT 1 FROM special_events WHERE id=?1 AND mutation_token=?2)';

/** A linked Facebook post (staff-identified promotion) must be a stored import
 *  that no other event already claims. */
async function linkablePost(env: any, postId: string) {
  if (!/^[\w-]{1,80}$/.test(postId)) throw new Error('Invalid Facebook post.');
  const row = await env.DB.prepare('SELECT fb_post_id,fb_created_time,permalink_url FROM special_imports WHERE fb_post_id=?1 ORDER BY rowid DESC LIMIT 1').bind(postId).first();
  if (!row) throw new Error('That Facebook post is no longer available.');
  if (await env.DB.prepare('SELECT 1 FROM special_events WHERE source_post_id=?1').bind(postId).first()) throw new Error('That Facebook post already has an event.');
  return row;
}

export async function createEvent(env: any, input: EventInput, sourcePostId = ''): Promise<string> {
  const id = `evt:${crypto.randomUUID()}`, token = crypto.randomUUID();
  const post = sourcePostId ? await linkablePost(env, sourcePostId) : null;
  const results = await env.DB.batch([
    prepare(env, `INSERT INTO special_events(id,title,event_date,time_text,start_time,end_time,details,status,origin,manual_locked,date_basis,
      source_post_id,source_created_time,source_permalink,mutation_token) SELECT ?1,?2,?3,?4,?5,?6,?7,'published','manual',1,'manual',?8,?9,?10,?11
      WHERE ?8 IS NULL OR NOT EXISTS(SELECT 1 FROM special_events WHERE source_post_id=?8)`,
      id, input.title, input.event_date, input.time_text, input.start_time, input.end_time, input.details,
      post?.fb_post_id ?? null, post?.fb_created_time ?? null, post?.permalink_url ?? '', token),
    ...offerStatements(env, id, input.offers, tokenGate, token),
  ]);
  if (results[0]?.meta?.changes !== 1) throw new Error('That Facebook post already has an event.');
  return id;
}

/** Saving staff edits locks the event against Facebook automation. */
export async function saveEvent(env: any, id: string, revision: number, input: EventInput, { approve = false } = {}): Promise<void> {
  const token = crypto.randomUUID();
  const results = await env.DB.batch([
    prepare(env, `UPDATE special_events SET title=?3,event_date=?4,time_text=?5,start_time=?6,end_time=?7,details=?8,
      status=CASE WHEN ?9 THEN 'published' ELSE status END,review_reason=CASE WHEN ?9 THEN '' ELSE review_reason END,
      manual_locked=1,revision=revision+1,mutation_token=?10,updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND revision=?2`,
      id, revision, input.title, input.event_date, input.time_text, input.start_time, input.end_time, input.details, approve ? 1 : 0, token),
    ...offerStatements(env, id, input.offers, tokenGate, token),
  ]);
  if (results[0]?.meta?.changes !== 1) throw new EventConflict();
}

export type EventAction = 'approve' | 'reject' | 'disable' | 'enable' | 'allow-automation' | 'delete';
/** Status changes are staff decisions: they lock the event. "Allow Facebook
 *  updates" is the only unlock, and only for an event Facebook created. */
export async function applyEventAction(env: any, id: string, revision: number, action: EventAction): Promise<void> {
  const event = await readEvent(env, id);
  if (!event) throw new Error('That event no longer exists.');
  if (event.revision !== revision) throw new EventConflict();
  let statement;
  if (action === 'delete') {
    // Facebook-created events stay as tombstones so a later scan cannot recreate them.
    if (event.origin !== 'manual') throw new Error('Events from Facebook cannot be deleted. Use Remove instead.');
    // Offers go first, in the same batch, without relying on foreign-key cascades.
    const results = await env.DB.batch([
      prepare(env, "DELETE FROM special_event_offers WHERE event_id=?1 AND EXISTS(SELECT 1 FROM special_events WHERE id=?1 AND revision=?2 AND origin='manual')", id, revision),
      prepare(env, "DELETE FROM special_events WHERE id=?1 AND revision=?2 AND origin='manual'", id, revision),
    ]);
    if (!(results[1]?.meta?.changes > 0)) throw new EventConflict();
    return;
  } else if (action === 'allow-automation') {
    if (event.origin !== 'automation' || !['review', 'published'].includes(event.status)) throw new Error('Only active events created from Facebook can follow Facebook updates.');
    const current = JSON.stringify({ title: event.title, event_date: event.event_date, time_text: event.time_text, start_time: event.start_time ?? null,
      end_time: event.end_time ?? null, details: event.details, offers: event.offers });
    statement = prepare(env, `UPDATE special_events SET manual_locked=0,last_auto_json=?3,revision=revision+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=?1 AND revision=?2 AND origin='automation'`, id, revision, current);
  } else {
    const status = { approve: 'published', enable: 'published', reject: 'rejected', disable: 'disabled' }[action];
    if (!status) throw new Error('Invalid event action.');
    if (action === 'approve' && event.status !== 'review') throw new Error('Only events awaiting review can be approved.');
    if (status === 'published' && !event.offers.length) throw new Error('Add at least one offer before publishing.');
    statement = prepare(env, `UPDATE special_events SET status=?3,review_reason=CASE WHEN ?3='published' THEN '' ELSE review_reason END,
      manual_locked=1,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND revision=?2`, id, revision, status);
  }
  const result = await statement.run();
  if (result?.meta?.changes !== 1) throw new EventConflict();
}

// ── Recent Facebook posts staff can identify as events ──
export type PostSuggestion = { fb_post_id: string; fb_created_time: string; permalink_url: string; caption: string; image_r2_key: string | null;
  heading: string; offers: string[]; event_date: string; date_note: string };
/** Recent stored posts with printed, priced offers that no event claims yet,
 *  newest first. Read-only; nothing is inferred beyond the stored evidence. */
export async function readPostSuggestions(env: any, now = new Date(), limit = 8): Promise<PostSuggestion[]> {
  try {
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { results } = await env.DB.prepare(`SELECT i.* FROM special_imports i
      WHERE julianday(i.fetched_at)>=julianday(?1) AND i.extracted_json IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=i.fb_post_id AND newer.rowid>i.rowid)
        AND NOT EXISTS(SELECT 1 FROM special_events e WHERE e.source_post_id=i.fb_post_id)
      ORDER BY i.rowid DESC LIMIT 25`).bind(since).all();
    // Graph times use "+0000", which SQLite date functions do not parse.
    return (results ?? []).filter((row: any) => Date.parse(row.fb_created_time) >= Date.parse(since)).flatMap((row: any) => {
      const suggestion = postSuggestion(row);
      return suggestion ? [suggestion] : [];
    }).slice(0, limit);
  } catch { return []; }
}
export function postSuggestion(row: any): PostSuggestion | null {
  let candidate: any;
  try { candidate = JSON.parse(String((row.processing_status === 'failed' ? row.extracted_json : row.candidate_json ?? row.extracted_json) ?? '').replace(/^```(?:json)?\n?|\n?```$/gm, '').trim()); }
  catch { return null; }
  if (!candidate || !Array.isArray(candidate.offers) || !candidate.offers.length) return null;
  let analyzed: any;
  try { analyzed = analyzeDailyEvidence(candidate); } catch { return null; }
  const offers = analyzed.offers.flatMap((o: any, i: number) => analyzed.issues.some((v: any) => v.index === i && v.reason !== 'Service not established by evidence')
    || /^\s*soups?\b/i.test(o?.content ?? '') ? [] : [String(o.content)]).filter((o: string) => o.length <= EVENT_OFFER_LIMIT).slice(0, EVENT_OFFER_COUNT);
  if (!offers.length) return null;
  const heading = `${candidate.day_evidence ?? ''} ${candidate.poster_evidence ?? ''}`.trim();
  const postDate = chicagoDateOf(row.fb_created_time);
  const date = resolveEventDate({ image: heading, caption: row.caption ?? '', postDate });
  return { fb_post_id: row.fb_post_id, fb_created_time: row.fb_created_time, permalink_url: row.permalink_url ?? '', caption: row.caption ?? '',
    image_r2_key: row.image_r2_key ?? null, heading, offers, event_date: date.date ?? postDate,
    date_note: date.review ? `Check the date: ${date.review}` : date.note ?? '' };
}
