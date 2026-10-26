// Special events (game days, holidays, one-time promotions): public reads and
// staff corrections. Facebook automation creates and publishes events; staff
// only edit or remove them. Events are separate from weekly specials and never
// appear in a day's specials card. Expiry is computed when read (America/Chicago);
// nothing is deleted on a schedule. Every staff write is fenced by the event's
// revision and token.
import { BUSINESS_TIME_ZONE, chicagoCalendarDate, isIsoCalendarDate } from './weekly-specials';

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
};
export type EventInput = { title: string; event_date: string; time_text: string; start_time: string | null; end_time: string | null; offers: string[] };
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

/** Published events that have not expired, today and upcoming, earliest first.
 *  Upcoming events show before their date. */
async function readCurrentEvents(env: any, now: Date): Promise<SpecialEvent[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM special_events WHERE status='published'
    AND event_date>=?1 ORDER BY event_date,start_time,title`).bind(chicagoCalendarDate(now)).all();
  return (await withOffers(env, results ?? [])).filter(e => e.offers.length && eventState(e, now) !== 'expired').sort(byDateAndTime);
}
/** Public pages. A missing table or database means no events, never a page error. */
export async function readVisibleEvents(env: any, now = new Date()): Promise<SpecialEvent[]> {
  try { return await readCurrentEvents(env, now); } catch { return []; }
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

// ── Staff administration (the Special Events section of /admin/specials) ──
/** Exactly what the public pages show: current and upcoming published events.
 *  Withheld, removed, cancelled and expired events are never listed. Throws when
 *  the events table is unavailable so the page can say so. */
export const readAdminEvents = (env: any, now = new Date()) => readCurrentEvents(env, now);
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
    start_time: clip('start_time', 5) || null, end_time: clip('end_time', 5) || null,
    offers: Array.from({ length: EVENT_OFFER_COUNT }, (_, i) => clip(`offer_${i + 1}`, EVENT_OFFER_LIMIT)) };
}
/** Server-side validation of every staff-submitted field; never trusts client limits. */
export function eventInputFromForm(form: FormData): EventInput {
  const title = text(form, 'title').replace(/\s+/g, ' ');
  const event_date = text(form, 'event_date');
  const time_text = text(form, 'time_text').replace(/\s+/g, ' ');
  const start_time = text(form, 'start_time') || null, end_time = text(form, 'end_time') || null;
  const offers = Array.from({ length: EVENT_OFFER_COUNT }, (_, i) => text(form, `offer_${i + 1}`)).filter(Boolean);
  if (!title) throw new Error('Enter an event name.');
  if (title.length > EVENT_TITLE_LIMIT) throw new Error(`The event name allows ${EVENT_TITLE_LIMIT} characters.`);
  if (!isIsoCalendarDate(event_date)) throw new Error('Choose a valid event date.');
  if (time_text.length > EVENT_TIME_LIMIT) throw new Error(`The time label allows ${EVENT_TIME_LIMIT} characters.`);
  if ((start_time && !TIME.test(start_time)) || (end_time && !TIME.test(end_time))) throw new Error('Enter start and end times as HH:MM.');
  if (start_time && end_time && end_time <= start_time) throw new Error('The end time must be after the start time on the same day.');
  if (!offers.length) throw new Error('Enter at least one offer, including its price.');
  if (offers.some(o => o.length > EVENT_OFFER_LIMIT)) throw new Error(`Each offer, including its price, allows ${EVENT_OFFER_LIMIT} characters.`);
  return { title, event_date, time_text, start_time, end_time, offers };
}

const prepare = (env: any, sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args);
function offerStatements(env: any, id: string, offers: string[], gate: string, ...gateArgs: unknown[]) {
  return [prepare(env, `DELETE FROM special_event_offers WHERE event_id=?1 AND ${gate}`, id, ...gateArgs),
    ...offers.map((content, i) => prepare(env, `INSERT INTO special_event_offers(event_id,position,content) SELECT ?1,?${gateArgs.length + 2},?${gateArgs.length + 3} WHERE ${gate}`, id, ...gateArgs, i + 1, content))];
}
const tokenGate = 'EXISTS(SELECT 1 FROM special_events WHERE id=?1 AND mutation_token=?2)';

/** Saving staff edits locks the event: Facebook automation never overwrites it.
 *  Only a published event can be edited; details are not part of the form. */
export async function saveEvent(env: any, id: string, revision: number, input: EventInput): Promise<void> {
  const token = crypto.randomUUID();
  const results = await env.DB.batch([
    prepare(env, `UPDATE special_events SET title=?3,event_date=?4,time_text=?5,start_time=?6,end_time=?7,
      manual_locked=1,revision=revision+1,mutation_token=?8,updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND revision=?2 AND status='published'`,
      id, revision, input.title, input.event_date, input.time_text, input.start_time, input.end_time, token),
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
