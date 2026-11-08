import { normalizeMenuCase } from './text-case.js';

export const PIZZA_OPTIONS_KEY = 'menu_pizza_options';
export const PIZZA_SIZES = ['6"', '12"', '16"'];
// Labels saved by earlier releases read as today's, so no D1 rewrite is needed.
const LEGACY_SIZES = { Personal: '6"', '6 Inch': '6"', '12 Inch': '12"', '16 Inch': '16"' };
export const PIZZA_CRUSTS = ['Thin', 'Regular', 'Deep Dish'];
// Original printed-menu choices confirmed by JJ; no historical pricing imported.
export const PIZZA_TOPPINGS = [
  'Sausage', 'Pepperoni', 'Canadian Bacon', 'Beef', 'Bacon', 'Diced Chicken',
  'Onions', 'Green Peppers', 'Tomatoes', 'Sauerkraut', 'Jalapenos', 'Green Olives',
  'Black Olives', 'Mushrooms', 'Pineapple', 'Banana Peppers', 'Pickles', 'Spinach',
  'Feta Cheese', 'Bleu Cheese Crumbles',
];
export const PIZZA_SCOPE = 'For all pizzas. Excludes Pizza Fries, which has its own sizes.';
export const isPizzaCategory = name => name.trim().toLowerCase() === 'pizzas';
const defaults = () => ({ sizes: [...PIZZA_SIZES], crusts: [...PIZZA_CRUSTS], toppings: [...PIZZA_TOPPINGS] });

function validate(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid pizza options.');
  if (Array.isArray(value.sizes)) value = { ...value, sizes: value.sizes.map(size => (Object.hasOwn(LEGACY_SIZES, size) ? LEGACY_SIZES[size] : size)) };
  for (const [key, allowed] of [['sizes', PIZZA_SIZES], ['crusts', PIZZA_CRUSTS]]) {
    if (!Array.isArray(value[key]) || value[key].some(entry => !allowed.includes(entry))) {
      throw new Error('Choose only the listed pizza sizes and crusts.');
    }
  }
  if (!Array.isArray(value.toppings) || value.toppings.length > 40 || value.toppings.some(
    entry => typeof entry !== 'string' || !entry.trim() || entry.length > 80 || /[\r\n]/.test(entry)
  )) throw new Error('Enter up to 40 toppings, one per line, with 80 characters or fewer per topping.');
  return {
    sizes: PIZZA_SIZES.filter(size => value.sizes.includes(size)),
    crusts: PIZZA_CRUSTS.filter(crust => value.crusts.includes(crust)),
    toppings: [...new Set(value.toppings.map(entry => normalizeMenuCase(entry.trim())))],
  };
}

export function pizzaOptionsFromForm(form) {
  const text = form.get('pizza_toppings') ?? '';
  if (typeof text !== 'string' || text.length > 3240) throw new Error('The topping list is too long.');
  return validate({ sizes: form.getAll('pizza_sizes'), crusts: form.getAll('pizza_crusts'),
    toppings: text.split(/\r?\n/).map(line => line.trim()).filter(Boolean) });
}

export async function getPizzaOptions(env) {
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(PIZZA_OPTIONS_KEY).first();
    return row ? validate(JSON.parse(row.value)) : defaults();
  } catch { return defaults(); }
}

export async function savePizzaOptions(env, options) {
  const value = validate(options);
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2')
    .bind(PIZZA_OPTIONS_KEY, JSON.stringify(value)).run();
  return value;
}
