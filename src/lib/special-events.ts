// Special events (game days, holidays, one-time promotions): public reads and
// staff writes. Facebook automation creates and publishes events; staff create
// their own, publish a held Facebook post as an event, and edit or remove any
// event. Staff events are locked: Facebook never overwrites or duplicates them.
// Events are separate from weekly specials and never appear in a day's specials
// card. Expiry is computed when read (America/Chicago); nothing is deleted on a
// schedule. Every staff write is fenced by the event's revision and token.
import { BUSINESS_TIME_ZONE, chicagoCalendarDate, isIsoCalendarDate } from './weekly-specials';
import { eventCue } from '../../workers/fb-feed/events.js';
import { factKey } from '../../workers/fb-feed/evidence.js';

export const EVENT_TITLE_LIMIT = 80;
export const EVENT_TIME_LIMIT = 80;
export const EVENT_OFFER_LIMIT = 150;
export const EVENT_OFFER_COUNT = 4;

export type EventStatus = 'review' | 'published' | 'disabled' | 'rejected' | 'cancelled';
export type SpecialEvent = {
  id: string; title: string; event_date: string; time_text: string; start_time: string | null; end_time: string | null;
  details: string; status: EventStatus; origin: 'manual' | 'automation'; manual_locked: number; date_basis: string;
  source_post_id: string | null; source_permalink: string; source_created_time: string | null; evidence_json: string | null;
  last_auto_json: string | null; review_reason: string; revision: number; updated_at: string; offers: string[];
  /** Migration 0028: first Chicago date customers see the event advertised. */
  display_from?: string | null;
};
/** hours: 'all-day' is valid for the whole Chicago calendar day; 'hours' is the
 *  start_time–end_time window on event_date. display_from is website visibility
 *  only and never changes when the offer is valid. */
export type EventInput = {
  title: string; event_date: string; hours: 'all-day' | 'hours'; time_text: string; start_time: string | null; end_time: string | null;
  display_from: string | null; offers: string[];
};
export class EventConflict extends Error {
  constructor() { super('This event changed after you opened it. Your edits are shown below; reload to compare before saving again.'); }
}
export class EventDuplicate extends Error {}

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
/** Without an end time an event lasts through its Chicago calendar day. On its
 *  date, an event with a start time is 'later' (never active) until it starts. */
export function eventState(event: Pick<SpecialEvent, 'event_date' | 'end_time'> & { start_time?: string | null }, now = new Date()): 'upcoming' | 'later' | 'active' | 'expired' {
  const today = chicagoCalendarDate(now);
  if (event.event_date < today) return 'expired';
  if (event.event_date > today) return 'upcoming';
  const clock = chicagoClock(now);
  if (event.end_time && clock >= event.end_time) return 'expired';
  return event.start_time && clock < event.start_time ? 'later' : 'active';
}
/** Website visibility: from display_from (when staff set one) until the event expires. */
export const eventDisplayed = (event: { display_from?: string | null }, now = new Date()) =>
  !event.display_from || event.display_from <= chicagoCalendarDate(now);

async function withOffers(env: any, events: any[]): Promise<SpecialEvent[]> {
  if (!events.length) return [];
  const { results: offers } = await env.DB.prepare('SELECT event_id,position,content FROM special_event_offers WHERE event_id IN (SELECT value FROM json_each(?1)) ORDER BY event_id,position')
    .bind(JSON.stringify(events.map(e => e.id))).all();
  return events.map(e => ({ ...e, offers: (offers ?? []).filter((o: any) => o.event_id === e.id).map((o: any) => o.content) }));
}
const byDateAndTime = (a: SpecialEvent, b: SpecialEvent) => a.event_date.localeCompare(b.event_date)
  || (a.start_time ?? '').localeCompare(b.start_time ?? '') || a.title.localeCompare(b.title);

/** Published events that have not expired, today and upcoming, earliest first.
 *  Bounded: at most 50 current events are read. */
async function readCurrentEvents(env: any, now: Date): Promise<SpecialEvent[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM special_events WHERE status='published'
    AND event_date>=?1 ORDER BY event_date,start_time,title LIMIT 50`).bind(chicagoCalendarDate(now)).all();
  return (await withOffers(env, results ?? [])).filter(e => e.offers.length && eventState(e, now) !== 'expired').sort(byDateAndTime);
}
/** Public pages: upcoming events show before their date, from their display date
 *  when staff set one. A missing table or database means no events, never a page error. */
export async function readVisibleEvents(env: any, now = new Date()): Promise<SpecialEvent[]> {
  try { return (await readCurrentEvents(env, now)).filter(e => eventDisplayed(e, now)); } catch { return []; }
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
export const formatEventDate = (date: string, style: 'short' | 'long' = 'short'): string => new Intl.DateTimeFormat('en-US',
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
/** When the offer is valid, for customers: the hours, any printed label, or "All day"
 *  for an event staff scheduled for the whole day. */
export function eventAvailability(event: Pick<SpecialEvent, 'time_text' | 'start_time' | 'end_time' | 'origin'>): string {
  return formatEventTime(event) || (event.origin === 'manual' ? 'All day' : '');
}

// ── Staff administration (the Special Events section of /admin/specials) ──
/** Current and upcoming published events, including those whose website display
 *  date has not arrived (staff see them first). Withheld, removed, cancelled and
 *  expired events are never listed. Throws when the events table is unavailable
 *  so the page can say so. */
export const readAdminEvents = (env: any, now = new Date()) => readCurrentEvents(env, now);
/** Migration 0028 adds display_from. Until it is applied staff can still create
 *  and edit events; only the website display date control is unavailable. */
export async function eventDisplaySupported(env: any): Promise<boolean> {
  try { await env.DB.prepare('SELECT display_from FROM special_events LIMIT 0').all(); return true; } catch { return false; }
}
export async function readEvent(env: any, id: string): Promise<SpecialEvent | null> {
  if (!/^evt:[\w-]{1,64}$/.test(id)) return null;
  const row = await env.DB.prepare('SELECT * FROM special_events WHERE id=?1').bind(id).first();
  return row ? (await withOffers(env, [row]))[0] : null;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const text = (form: FormData, name: string) => String(form.get(name) ?? '').replace(/\r\n?/g, '\n').trim();
// Forms without hours_mode (older pages) mean Specific Hours when any time is given.
function hoursMode(form: FormData): EventInput['hours'] {
  const mode = text(form, 'hours_mode');
  if (mode === 'all-day' || mode === 'hours') return mode;
  if (mode) throw new Error('Choose All Day or Specific Hours.');
  return text(form, 'start_time') || text(form, 'end_time') ? 'hours' : 'all-day';
}
/** Submitted values for redisplay after a validation error (never saved). */
export function eventDraftFromForm(form: FormData): EventInput {
  const clip = (name: string, limit: number) => text(form, name).slice(0, limit);
  let hours: EventInput['hours'] = 'all-day';
  try { hours = hoursMode(form); } catch { /* Redisplay only. */ }
  return { title: clip('title', EVENT_TITLE_LIMIT), event_date: clip('event_date', 10), hours, time_text: clip('time_text', EVENT_TIME_LIMIT),
    start_time: clip('start_time', 5) || null, end_time: clip('end_time', 5) || null, display_from: clip('display_from', 10) || null,
    offers: Array.from({ length: EVENT_OFFER_COUNT }, (_, i) => clip(`offer_${i + 1}`, EVENT_OFFER_LIMIT)) };
}
/** Form values for an existing event. */
export const eventValues = (event: SpecialEvent): EventInput => ({ title: event.title, event_date: event.event_date,
  hours: event.start_time || event.end_time ? 'hours' : 'all-day', time_text: event.time_text, start_time: event.start_time,
  end_time: event.end_time, display_from: event.display_from ?? null, offers: event.offers });
/** Server-side validation of every staff-submitted field; never trusts client limits. */
export function eventInputFromForm(form: FormData): EventInput {
  const title = text(form, 'title').replace(/\s+/g, ' ');
  const event_date = text(form, 'event_date');
  const time_text = text(form, 'time_text').replace(/\s+/g, ' ');
  const hours = hoursMode(form);
  // All Day ignores any times left in the hidden time inputs.
  const start_time = hours === 'hours' ? text(form, 'start_time') || null : null;
  const end_time = hours === 'hours' ? text(form, 'end_time') || null : null;
  const display_from = text(form, 'display_from') || null;
  const offers = Array.from({ length: EVENT_OFFER_COUNT }, (_, i) => text(form, `offer_${i + 1}`)).filter(Boolean);
  if (!title) throw new Error('Enter an event name.');
  if (title.length > EVENT_TITLE_LIMIT) throw new Error(`The event name allows ${EVENT_TITLE_LIMIT} characters.`);
  if (!isIsoCalendarDate(event_date)) throw new Error('Choose a valid event date.');
  if (time_text.length > EVENT_TIME_LIMIT) throw new Error(`The time label allows ${EVENT_TIME_LIMIT} characters.`);
  if ((start_time && !TIME.test(start_time)) || (end_time && !TIME.test(end_time))) throw new Error('Enter start and end times as HH:MM.');
  if (hours === 'hours' && (!start_time || !end_time)) throw new Error('Specific Hours needs both a start time and an end time.');
  // One Chicago calendar day per event: hours past midnight are never widened to all day.
  if (start_time && end_time && end_time <= start_time) throw new Error('The end time must be after the start time on the same day. For hours past midnight, add a second event for the next day.');
  if (display_from && !isIsoCalendarDate(display_from)) throw new Error('Choose a valid website display date.');
  if (display_from && display_from > event_date) throw new Error('The website display date must be on or before the event date.');
  if (!offers.length) throw new Error('Enter at least one offer, including its price.');
  if (offers.some(o => o.length > EVENT_OFFER_LIMIT)) throw new Error(`Each offer, including its price, allows ${EVENT_OFFER_LIMIT} characters.`);
  return { title, event_date, hours, time_text, start_time, end_time, display_from, offers };
}

const prepare = (env: any, sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args);
function offerStatements(env: any, id: string, offers: string[], gate: string, ...gateArgs: unknown[]) {
  return [prepare(env, `DELETE FROM special_event_offers WHERE event_id=?1 AND ${gate}`, id, ...gateArgs),
    ...offers.map((content, i) => prepare(env, `INSERT INTO special_event_offers(event_id,position,content) SELECT ?1,?${gateArgs.length + 2},?${gateArgs.length + 3} WHERE ${gate}`, id, ...gateArgs, i + 1, content))];
}
const tokenGate = 'EXISTS(SELECT 1 FROM special_events WHERE id=?1 AND mutation_token=?2)';

/** Saving staff edits locks the event: Facebook automation never overwrites it.
 *  Only a published event can be edited; details are not part of the form.
 *  display: migration 0028 is applied, so the display date is saved too. */
export async function saveEvent(env: any, id: string, revision: number, input: EventInput, { display = false } = {}): Promise<void> {
  const token = crypto.randomUUID();
  const results = await env.DB.batch([
    prepare(env, `UPDATE special_events SET title=?3,event_date=?4,time_text=?5,start_time=?6,end_time=?7,${display ? 'display_from=?9,' : ''}
      manual_locked=1,revision=revision+1,mutation_token=?8,updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND revision=?2 AND status='published'`,
      id, revision, input.title, input.event_date, input.time_text, input.start_time, input.end_time, token, ...(display ? [input.display_from] : [])),
    ...offerStatements(env, id, input.offers, tokenGate, token),
  ]);
  if (results[0]?.meta?.changes !== 1) throw new EventConflict();
}

/** Removing hides the event everywhere and keeps a locked tombstone (with its
 *  Facebook post id) so later scans of that post never recreate it. */
export async function removeEvent(env: any, id: string, revision: number): Promise<void> {
  const result = await prepare(env, `UPDATE special_events SET status='rejected',review_reason='Removed by staff',manual_locked=1,
    revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND revision=?2 AND status='published'`, id, revision).run();
  if (result?.meta?.changes !== 1) throw new EventConflict();
}

// ── Staff-created events ──
/** The identity and fingerprint automation matches (events.js, event-store.js), so
 *  a later Facebook post for an event staff already entered never adds a second card. */
export const eventIdentity = (title: string): string | null => eventCue(title)?.identity ?? null;
export const eventFingerprint = (date: string, offers: string[]) => `${date}|${offers.map(factKey).sort().join('|')}`;
const IMPORT_ID = /^[a-zA-Z0-9_-]{1,100}$/;

/** A held Facebook post staff chose to publish as an event: today's newest reading
 *  of that post. The staff-locked event then keeps the poster out of the daily
 *  specials (eventSourceIndexes in the Worker). */
async function linkedSource(env: any, importId: string, now: Date) {
  if (!IMPORT_ID.test(importId)) throw new Error('That Facebook post is not available. Reload Automation Review.');
  const source = await env.DB.prepare(`SELECT id,fb_post_id,fb_created_time,permalink_url FROM special_imports i WHERE id=?1
    AND processing_status IN ('staged','failed') AND review_status IN ('pending','accepted','edited')
    AND NOT EXISTS(SELECT 1 FROM special_imports n WHERE n.fb_post_id=i.fb_post_id AND n.rowid>i.rowid)`).bind(importId).first();
  const created = source ? new Date(source.fb_created_time) : null;
  if (!source || !created || !Number.isFinite(created.getTime()) || created > now || chicagoCalendarDate(created) !== chicagoCalendarDate(now))
    throw new Error('Only today’s current Facebook posts can be published as an event. Reload Automation Review.');
  return source;
}

/** Publishes a staff event and returns its id. `requestId` is issued with the form,
 *  so a repeated submit is idempotent. With `sourceImportId`, the event is linked to
 *  that held Facebook post (an event automation withheld for it is taken over). */
export async function createEvent(env: any, input: EventInput,
  { requestId, sourceImportId = '', display = false, now = new Date() }: { requestId: string; sourceImportId?: string; display?: boolean; now?: Date }): Promise<string> {
  if (!/^[0-9a-f-]{36}$/.test(requestId)) throw new Error('Reload this page before adding an event.');
  const id = `evt:staff-${requestId}`;
  if (await env.DB.prepare('SELECT 1 FROM special_events WHERE id=?1').bind(id).first()) return id;   // This form already saved it.
  if (input.event_date < chicagoCalendarDate(now)) throw new Error('Choose today or a future date.');
  const source = sourceImportId ? await linkedSource(env, sourceImportId, now) : null;
  const identity = eventIdentity(input.title), fingerprint = eventFingerprint(input.event_date, input.offers);
  // An unrecognized title gets a unique identity, so a removed staff event never
  // becomes an unnamed tombstone that blocks every Facebook event on its date.
  const storedIdentity = identity ?? `staff:${requestId}`;
  // Conservative duplicate rule: the same recognized event, or the same offers, on the same date.
  const duplicate = await env.DB.prepare(`SELECT id,title FROM special_events WHERE status='published' AND event_date=?1
    AND (fingerprint=?2 OR (?3 IS NOT NULL AND identity=?3)) LIMIT 1`).bind(input.event_date, fingerprint, identity).first();
  if (duplicate) throw new EventDuplicate(`“${duplicate.title}” is already published for ${formatEventDate(input.event_date, 'long')}. Edit that event instead of adding another.`);
  const existing = source ? await env.DB.prepare('SELECT id,status,origin,manual_locked,revision FROM special_events WHERE source_post_id=?1').bind(source.fb_post_id).first() : null;
  if (existing && !(existing.status === 'review' && existing.origin === 'automation' && existing.manual_locked === 0))
    throw new EventDuplicate('This Facebook post already has a special event. Edit it in Special Events.');
  const token = crypto.randomUUID(), displayArgs = display ? [input.display_from] : [];
  const detail = source ? 'Published by staff from a held Facebook post' : 'Created by staff';
  if (existing) {
    // Staff publish the event automation withheld for this post: the same row
    // keeps the post unique, and it becomes staff-locked.
    const results = await env.DB.batch([
      prepare(env, `UPDATE special_events SET title=?3,event_date=?4,time_text=?5,start_time=?6,end_time=?7,status='published',manual_locked=1,
        date_basis='manual',fingerprint=?9,review_reason='',revision=revision+1,mutation_token=?8,updated_at=CURRENT_TIMESTAMP${display ? ',display_from=?10' : ''}
        WHERE id=?1 AND revision=?2 AND status='review' AND origin='automation' AND manual_locked=0`,
        existing.id, existing.revision, input.title, input.event_date, input.time_text, input.start_time, input.end_time, token, fingerprint, ...displayArgs),
      ...offerStatements(env, existing.id, input.offers, tokenGate, token),
      prepare(env, `INSERT INTO special_event_log(event_id,source_post_id,action,detail) SELECT ?1,?3,'updated',?4 WHERE ${tokenGate}`, existing.id, token, source!.fb_post_id, detail),
    ]);
    if (results[0]?.meta?.changes !== 1) throw new EventConflict();
    return existing.id;
  }
  // The duplicate and source checks repeat inside the insert, so two concurrent
  // saves (or a Facebook scan in between) never publish two matching cards.
  const results = await env.DB.batch([
    prepare(env, `INSERT INTO special_events(id,mutation_token,title,event_date,time_text,start_time,end_time,details,status,origin,manual_locked,date_basis,
      fingerprint,identity,source_post_id,source_import_id,source_created_time,source_permalink,evidence_json,review_reason${display ? ',display_from' : ''})
      SELECT ?1,?2,?3,?4,?5,?6,?7,'','published','manual',1,'manual',?8,?9,?10,?11,?12,?13,?14,''${display ? ',?15' : ''}
      WHERE NOT EXISTS(SELECT 1 FROM special_events WHERE id=?1 OR (?10 IS NOT NULL AND source_post_id=?10)
        OR (status='published' AND event_date=?4 AND (fingerprint=?8 OR identity=?9)))`,
      id, token, input.title, input.event_date, input.time_text, input.start_time, input.end_time, fingerprint, storedIdentity,
      source?.fb_post_id ?? null, source?.id ?? null, source?.fb_created_time ?? null, source?.permalink_url ?? '',
      JSON.stringify(source ? { created_by: 'staff', import_id: source.id } : { created_by: 'staff' }), ...displayArgs),
    ...input.offers.map((content, i) => prepare(env, `INSERT INTO special_event_offers(event_id,position,content) SELECT ?1,?3,?4 WHERE ${tokenGate}`, id, token, i + 1, content)),
    prepare(env, `INSERT INTO special_event_log(event_id,source_post_id,action,detail) SELECT ?1,?3,'created',?4 WHERE ${tokenGate}`, id, token, source?.fb_post_id ?? null, detail),
  ]);
  if (results[0]?.meta?.changes === 1) return id;
  if (await env.DB.prepare('SELECT 1 FROM special_events WHERE id=?1').bind(id).first()) return id;
  throw new EventDuplicate('A matching event was published at the same time. Reload to review it before adding another.');
}
