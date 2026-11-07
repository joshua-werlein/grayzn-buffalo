// One display/visibility contract shared by Astro, the editor and the Facebook Worker.
import {splitMexicanItem} from './mexican-item.js';

export const WING_SAUCES_GROUP = 'ww-default:sauces';
export const WING_OPTIONS_GROUP = 'ww-live:ww-default:wings';

export const isWingSauceGroup = group => String(group?.id ?? '').endsWith(WING_SAUCES_GROUP);
export const parseWingSauces = content => String(content ?? '').split(/[\r\n,]+/).map(sauce => sauce.trim()).filter(Boolean);

// Presentation only: "Bone-In Wings $X.XX each" -> name and price.
export function splitWingPrice(title) {
  const text = String(title ?? '').trim();
  const at = text.indexOf('$');
  return at < 1 ? {name: text, price: ''} : {name: text.slice(0, at).trim(), price: text.slice(at).trim()};
}

// A price however staff or a poster wrote it: $1.10 each, $1 per wing, $1.25/each,
// 2 for $3, 89 cents, 89¢. Only the item name is read; descriptions are left alone.
const PRICE_TEXT = /(?:\b\d+\s*for\s*)?(?:\$\s*(?:\d+(?:\.\d*)?|\.\d+)|\b\d+(?:\.\d+)?\s*(?:¢|cents?\b|dollars?\b)|\b\d+c\b)(?:\s*(?:\/\s*|per\s+)?(?:each|ea\b\.?|wings?\b|piece\b|pc\b))?/gi;
const nameOf = title => String(title ?? '').replace(PRICE_TEXT, ' ').replace(/\s+/g, ' ')
  .replace(/^[\s\-–—:,/@|]+|(?:[\s\-–—:,/@|]|\s(?:for|at)\b)+$/gi, '').trim();
export const wingItemName = title => nameOf(title);
export const wingPriceText = title => (String(title ?? '').match(PRICE_TEXT) ?? []).join(' ').toLowerCase().replace(/\s+/g, '');

function wingOptionType(content) {
  const name = nameOf(splitMexicanItem(content).title);
  const boneIn = /\bbone[\s-]*in\b/i.test(name), boneless = /\bbone[\s-]*less\b/i.test(name);
  return boneIn === boneless ? null : boneIn ? 'boneIn' : 'boneless';
}
/** The one slot each wing type names, or null when none or several do. Never by position. */
export function wingOptionSlots(slots) {
  const options = (slots ?? []).filter(slot => slot.position <= 2);
  const named = type => { const found = options.filter(slot => wingOptionType(slot.content) === type); return found.length === 1 ? found[0] : null; };
  return {boneIn: named('boneIn'), boneless: named('boneless')};
}
/** Where staff review should look for each type. A slot naming neither takes what is left. */
export function wingOptionPositions(slots) {
  const {boneIn, boneless} = wingOptionSlots(slots);
  const first = boneIn?.position ?? (boneless?.position === 1 ? 2 : 1);
  return {boneIn: first, boneless: boneless?.position ?? (first === 1 ? 2 : 1)};
}

const shiftDate = (date, days) => {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};
/**
 * The week a staff save belongs to: Sunday already looks ahead to the coming Wednesday,
 * as the weekly transaction does at 7 PM, and any other day to this week's.
 */
export function wingWeekFor(now = new Date()) {
  const parts = Object.fromEntries(chicagoNow.formatToParts(now).map(p => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const weekStart = shiftDate(today, weekday === 0 ? 1 : 1 - weekday);
  return {weekStart, serviceDate: shiftDate(weekStart, 2), isSunday: weekday === 0};
}

const chicagoNow = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23',
});

/**
 * Visible from Sunday 7 PM before its associated Wednesday until 1:59 AM Thursday,
 * Chicago time. Hiding removes nothing. Keyed to the service date so an edit to
 * last week's section never reopens it, and an edit on Sunday afternoon for the
 * coming Wednesday waits for 7 PM.
 */
export function wingWednesdayVisible(serviceDate, now = new Date()) {
  if (typeof serviceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return false;
  let parts;
  try { parts = Object.fromEntries(chicagoNow.formatToParts(now).map(p => [p.type, p.value])); }
  catch { return false; }
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);
  if (today === shiftDate(serviceDate, -3)) return hour >= 19;
  if (today > shiftDate(serviceDate, -3) && today <= serviceDate) return true;
  return today === shiftDate(serviceDate, 1) && hour < 2;
}
