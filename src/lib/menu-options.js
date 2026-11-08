// Shared, staff-editable options shown in light panels on the public Menu: Wraps notes,
// Salads dressings/greens/shell markers, and Substitute Sides. Each is one JSON row in
// `settings`, like pizza options. No prices: none are stored or shown.
import { normalizeMenuCase } from './text-case.js';

export const WRAP_OPTIONS_KEY = 'menu_wrap_options';
export const SALAD_OPTIONS_KEY = 'menu_salad_options';
export const SUBSTITUTE_SIDES_KEY = 'menu_substitute_sides';

// From the printed menu (JJ). No tortilla flavors are documented, so none are listed.
export const WRAP_NOTES = [
  'Chicken can be Grilled or Crispy where applicable.',
  'Any sandwich can be made into a wrap.',
  'All Wraps Served with Chips and a Pickle. See Substitute Sides.',
];
export const SALAD_DRESSINGS = [
  'French', 'Fat Free French', 'Ranch', 'Fat Free Ranch', 'Low Cal Ranch', 'Bleu Cheese',
  'Raspberry Vinaigrette', 'Italian', 'Thousand Island', 'Caesar', 'Honey Mustard', 'White Balsamic Shallot Vinaigrette',
];
export const SALAD_GREENS = ['Iceberg', 'Spinach Mix'];
// The salads the printed menu marks with an asterisk, by their current item names.
export const SALAD_SHELL_ITEMS = ['Chef Salad', 'Taco Salad', 'Grilled/Crispy Chicken Salad', 'Caesar Salad'];
// Marked with a dagger, distinct from the Burgers food-safety asterisk.
export const SALAD_SHELL_MARK = '†';
export const SALAD_SHELL_NOTE = '† Indicates Salad Comes with a Shell. No Shells for Lighter Side Salads.';
export const SUBSTITUTE_SIDES = [
  'French Fries or Tots',
  'Beer Fries, Sweet Potato Fries, or Waffle Fries',
  'Steamed Broccoli or Side Salad',
  'Mac ’n’ Cheese or Onion Rings',
];
// States where substitutions apply without implying they are free.
export const SUBSTITUTE_SIDES_NOTE = 'Available as substitutions for Wraps, Sandwiches and Burgers.';

export const isWrapCategory = name => String(name ?? '').trim().toLowerCase() === 'wraps';
export const isSaladCategory = name => String(name ?? '').trim().toLowerCase() === 'salads';
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
export const hasShell = (options, itemName) => options.shells.some(name => sameName(name, itemName));
/** "Choice of Iceberg or Spinach Mix." */
export function greensText(greens) {
  if (!greens.length) return '';
  return `Choice of ${greens.length === 1 ? greens[0] : `${greens.slice(0, -1).join(', ')} or ${greens.at(-1)}`}.`;
}

/**
 * One validated list. `caseRule` applies the house capitalization (choice names, like
 * pizza toppings); free-text lines are kept as typed, like section notes.
 */
function list(value, { max, length, caseRule, label }) {
  if (!Array.isArray(value) || value.length > max || value.some(entry =>
    typeof entry !== 'string' || !entry.trim() || entry.trim().length > length || /[\r\n]/.test(entry)))
    throw new Error(`Enter up to ${max} ${label}, one per line, with ${length} characters or fewer each.`);
  const seen = new Set();
  return value.map(entry => (caseRule ? normalizeMenuCase(entry.trim()) : entry.trim()))
    .filter(entry => !seen.has(entry.toLowerCase()) && seen.add(entry.toLowerCase()));
}
const validators = {
  [WRAP_OPTIONS_KEY]: value => ({ notes: list(value?.notes, { max: 6, length: 160, label: 'wrap notes' }) }),
  [SALAD_OPTIONS_KEY]: value => ({
    dressings: list(value?.dressings, { max: 30, length: 80, caseRule: true, label: 'dressings' }),
    greens: list(value?.greens, { max: 6, length: 40, caseRule: true, label: 'greens' }),
    shells: list(value?.shells, { max: 40, length: 80, label: 'shell salads' }),
  }),
  [SUBSTITUTE_SIDES_KEY]: value => ({ sides: list(value?.sides, { max: 8, length: 120, label: 'substitute sides' }), lateNight: value?.lateNight === true }),
};
const defaults = {
  [WRAP_OPTIONS_KEY]: () => ({ notes: [...WRAP_NOTES] }),
  [SALAD_OPTIONS_KEY]: () => ({ dressings: [...SALAD_DRESSINGS], greens: [...SALAD_GREENS], shells: [...SALAD_SHELL_ITEMS] }),
  [SUBSTITUTE_SIDES_KEY]: () => ({ sides: [...SUBSTITUTE_SIDES], lateNight: false }),
};

/** Saved options, or the printed-menu defaults when unsaved or unreadable. An empty saved list stays empty. */
export async function getMenuOptions(env, key) {
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first();
    return row ? validators[key](JSON.parse(row.value)) : defaults[key]();
  } catch { return defaults[key](); }
}

export async function saveMenuOptions(env, key, value) {
  const valid = validators[key](value);
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2')
    .bind(key, JSON.stringify(valid)).run();
  return valid;
}

const lines = (form, name, limit) => {
  const text = form.get(name) ?? '';
  if (typeof text !== 'string' || text.length > limit) throw new Error('That list is too long.');
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
};
export const wrapOptionsFromForm = form => validators[WRAP_OPTIONS_KEY]({ notes: lines(form, 'wrap_notes', 1200) });
export const saladOptionsFromForm = form => validators[SALAD_OPTIONS_KEY]({
  dressings: lines(form, 'salad_dressings', 3000), greens: lines(form, 'salad_greens', 400),
  shells: form.getAll('salad_shells').map(String),
});
export const substituteSidesFromForm = form => validators[SUBSTITUTE_SIDES_KEY]({
  sides: lines(form, 'substitute_sides', 1200), lateNight: form.get('substitute_sides_late_night') === 'on',
});
