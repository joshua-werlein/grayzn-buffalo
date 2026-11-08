// The public Menu's Sauces section shows the one staff-managed sauce list: the live
// Wing Wednesday Sauces group (edited in the Wing Wednesday editor). No second list,
// no prices. It is not a category row; only its position is stored, in `settings`,
// on the same number scale as categories.sort.
import { getWingWednesday, visibleGroups, visibleSlots } from './specials-store';
import { isWingSauceGroup, parseWingSauces } from './wing-wednesday.js';
import { SAUCES_SECTION, SECTION_SORT_MAX, sectionName, validSectionSort, getSectionSort, saveSectionSortStatement, effectiveSectionSort, sectionIndex } from './menu-sections';

// Owner-confirmed: every sauce goes with anything on the menu, every day, and the
// list is complete. No prices or surcharges are stated.
export const MENU_SAUCE_NOTE = 'Pair any sauce with anything on the menu. Available every day.';
// Position, heading and anchor rules are shared with other virtual sections (menu-sections.ts).
export const SAUCES_ANCHOR = SAUCES_SECTION.anchor;
/** "Sauces", or a distinct name when a staff category is already called Sauces (any case). */
export const saucesSectionName = (categories: { name: string }[]) => sectionName(categories, SAUCES_SECTION);
export const SAUCES_SORT_KEY = SAUCES_SECTION.sortKey;
export const SAUCES_SORT_MAX = SECTION_SORT_MAX;

/** Empty when the Wing Wednesday schema, group or content is missing; never throws. */
export async function getMenuSauces(env: any): Promise<string[]> {
  try {
    const wing = await getWingWednesday(env);
    if (!wing) return [];
    const groups = visibleGroups(wing.groups).filter(isWingSauceGroup);
    return [...new Set(groups.flatMap(group => visibleSlots(group).flatMap(slot => parseWingSauces(slot.content))))];
  } catch { return []; }
}

type Cat = { name: string; sort: number };
export const validSaucesSort = validSectionSort;
/** The saved position, or null (unsaved or unreadable: the default after Appetizers applies). */
export const getSaucesSort = (env: any) => getSectionSort(env, SAUCES_SECTION);
/** The INSERT for a validated position, so it can join the category sort batch. */
export const saveSaucesSortStatement = (env: any, sort: number) => saveSectionSortStatement(env, SAUCES_SECTION, sort);
/** The number shown in the admin order field: the saved one, or Appetizers' (its default spot). */
export const effectiveSaucesSort = (categories: Cat[], saved: number | null) => effectiveSectionSort(categories, saved, SAUCES_SECTION);
/** After every category at or below its number (ties after); unsaved, right after Appetizers, else last. */
export const saucesIndex = (categories: Cat[], saved: number | null) => sectionIndex(categories, saved, SAUCES_SECTION);
