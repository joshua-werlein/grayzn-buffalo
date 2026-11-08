// Menu sections that are not category rows (Sauces, Substitute Sides). Only each one's
// position is stored, in `settings`, on the same number scale as categories.sort, and it
// is reordered in Admin › Menu › Manage Sections alongside the categories.
export const SECTION_SORT_MAX = 999;
type Cat = { name: string; sort: number };
export type VirtualSection = {
  /** Fixed anchor; category anchors are always `sec-<slug>`, so these never collide. */
  anchor: string;
  /** Preferred heading, then fallbacks for when a staff category already has that name. */
  names: string[];
  sortKey: string;
  /** Unsaved position: right after Appetizers, or after the last section. */
  fallback: 'afterAppetizers' | 'end';
};
export const SAUCES_SECTION: VirtualSection = { anchor: 'menu-sauces', names: ['Sauces', 'Wing Wednesday Sauces'], sortKey: 'menu_sauces_sort', fallback: 'afterAppetizers' };
export const SIDES_SECTION: VirtualSection = { anchor: 'menu-substitute-sides', names: ['Substitute Sides', 'Substitute Side Choices'], sortKey: 'menu_substitute_sides_sort', fallback: 'end' };

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const isAppetizers = (name: string) => name.trim().toLowerCase() === 'appetizers';

/**
 * The heading for a virtual section. A staff category with the same name (any case or
 * punctuation) is never changed; this section takes the next distinct name instead.
 */
export function sectionName(categories: { name: string }[], section: VirtualSection) {
  const taken = new Set(categories.map(c => slug(String(c.name ?? ''))));
  const free = section.names.find(name => !taken.has(slug(name)));
  if (free) return free;
  const last = section.names.at(-1)!;
  for (let n = 2; ; n++) if (!taken.has(slug(`${last} ${n}`))) return `${last} ${n}`;
}

export const validSectionSort = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value.trim())) return null;
  const sort = Number(value);
  return sort <= SECTION_SORT_MAX ? sort : null;
};

/** The saved position, or null (unsaved or unreadable: the section's default applies). */
export async function getSectionSort(env: any, section: VirtualSection): Promise<number | null> {
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(section.sortKey).first();
    return row ? validSectionSort(String(row.value)) : null;
  } catch { return null; }
}

/** The INSERT for a validated position, so it can join the category sort batch. */
export function saveSectionSortStatement(env: any, section: VirtualSection, sort: number) {
  return env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2')
    .bind(section.sortKey, String(sort));
}

/** The number shown in the admin order field: the saved one, or the one matching its default spot. */
export function effectiveSectionSort(categories: Cat[], saved: number | null, section: VirtualSection) {
  if (saved !== null) return saved;
  if (section.fallback === 'afterAppetizers') return categories.find(c => isAppetizers(c.name))?.sort ?? categories.at(-1)?.sort ?? 0;
  return categories.at(-1)?.sort ?? 0;
}

/**
 * Where the section goes in an ordered category list: after every category whose sort
 * is at or below its own (a tie sits after that category). Unsaved: its default spot.
 */
export function sectionIndex(categories: Cat[], saved: number | null, section: VirtualSection) {
  if (saved === null) {
    const at = section.fallback === 'afterAppetizers' ? categories.findIndex(c => isAppetizers(c.name)) : -1;
    return at < 0 ? categories.length : at + 1;
  }
  let index = 0;
  categories.forEach((c, i) => { if (c.sort <= saved) index = i + 1; });
  return index;
}

/** Interleaves blocks into a list at their indexes; blocks at the same index keep their given order. */
export function interleave<T, B>(list: T[], blocks: { index: number; block: B }[]): (T | B)[] {
  const out: (T | B)[] = [];
  for (let i = 0; i <= list.length; i++) {
    for (const b of blocks) if (b.index === i) out.push(b.block);
    if (i < list.length) out.push(list[i]);
  }
  return out;
}
