// The public Menu's Sauces section shows the one staff-managed sauce list: the live
// Wing Wednesday Sauces group (edited in the Wing Wednesday editor). No second list,
// no prices. It is not a category row; only its position is stored, in `settings`,
// on the same number scale as categories.sort.
import { getWingWednesday, visibleGroups, visibleSlots } from './specials-store';
import { isWingSauceGroup, parseWingSauces } from './wing-wednesday.js';

// Owner-confirmed: every sauce goes with anything on the menu, every day, and the
// list is complete. No prices or surcharges are stated.
export const MENU_SAUCE_NOTE = 'Pair any sauce with anything on the menu. Available every day.';
// Category anchors are always `sec-<slug>`, so this one can never collide with them.
export const SAUCES_ANCHOR = 'menu-sauces';
const sectionSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * The heading for the Wing Wednesday sauce section. Staff may have their own category
 * called "Sauces" (any case or punctuation); that category is never changed, so this
 * section takes a distinct name instead, keeping headings, links and menu.json unambiguous.
 */
export function saucesSectionName(categories: { name: string }[]) {
  const taken = new Set(categories.map(c => sectionSlug(String(c.name ?? ''))));
  if (!taken.has('sauces')) return 'Sauces';
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'Wing Wednesday Sauces' : `Wing Wednesday Sauces ${n}`;
    if (!taken.has(sectionSlug(name))) return name;
  }
}
export const SAUCES_SORT_KEY = 'menu_sauces_sort';
export const SAUCES_SORT_MAX = 999;
const isAppetizers = (name: string) => name.trim().toLowerCase() === 'appetizers';

/** Empty when the Wing Wednesday schema, group or content is missing; never throws. */
export async function getMenuSauces(env: any): Promise<string[]> {
  try {
    const wing = await getWingWednesday(env);
    if (!wing) return [];
    const groups = visibleGroups(wing.groups).filter(isWingSauceGroup);
    return [...new Set(groups.flatMap(group => visibleSlots(group).flatMap(slot => parseWingSauces(slot.content))))];
  } catch { return []; }
}

export const validSaucesSort = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value.trim())) return null;
  const sort = Number(value);
  return sort <= SAUCES_SORT_MAX ? sort : null;
};

/** The saved position, or null (unsaved or unreadable: the default after Appetizers applies). */
export async function getSaucesSort(env: any): Promise<number | null> {
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(SAUCES_SORT_KEY).first();
    return row ? validSaucesSort(String(row.value)) : null;
  } catch { return null; }
}

/** The INSERT for a validated position, so it can join the category sort batch. */
export function saveSaucesSortStatement(env: any, sort: number) {
  return env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2')
    .bind(SAUCES_SORT_KEY, String(sort));
}

/** The number shown in the admin order field: the saved one, or Appetizers' (its default spot). */
export function effectiveSaucesSort(categories: { name: string; sort: number }[], saved: number | null) {
  return saved ?? categories.find(c => isAppetizers(c.name))?.sort ?? null;
}

/**
 * Where Sauces goes in an ordered category list: after every category whose sort is at
 * or below its own (so a tie with Appetizers' number sits right after Appetizers).
 * Unsaved: right after Appetizers, or last when there is no Appetizers section.
 */
export function saucesIndex(categories: { name: string; sort: number }[], saved: number | null) {
  if (saved === null) {
    const at = categories.findIndex(c => isAppetizers(c.name));
    return at < 0 ? categories.length : at + 1;
  }
  let index = 0;
  categories.forEach((c, i) => { if (c.sort <= saved) index = i + 1; });
  return index;
}
