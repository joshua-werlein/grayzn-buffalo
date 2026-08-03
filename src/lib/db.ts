// D1 helpers with graceful fallback so dev/build works before provisioning.
export type Special = {
  day_of_week: number;
  lunch_name: string;
  lunch_description: string;
  lunch_tag: string | null;
  night_name: string;
  night_description: string;
  night_tag: string | null;
};
export type Item = { id: number; category_id: number; name: string; description: string; sort: number; active: number; photo_key: string | null; late_night: number };
export type Category = { id: number; name: string; sort: number };
export type WelcomePhoto = { slot: number; photo_key: string | null; alt: string; caption: string };
export const thumbKey = (key: string) => key.replace(/\.webp$/, '@600.webp');
 
const FALLBACK_SPECIALS = [
  { day_of_week: 0, name: 'Broasted Chicken Dinner', description: 'Golden broasted chicken with all the fixings.', tag: null },
  { day_of_week: 1, name: 'Burger & Basket Night', description: "Grayz'n Burger with a basket of waffle fries.", tag: null },
  { day_of_week: 2, name: 'Mexican Night', description: 'Tacos, quesadillas, and wet burritos.', tag: 'Mexican Night' },
  { day_of_week: 3, name: 'Grilled Chicken Salad', description: "Plus the Grayz'n Burger with a side.", tag: null },
  { day_of_week: 4, name: 'Soup & Sandwich', description: "Cup of the day's soup with a grilled sandwich.", tag: null },
  { day_of_week: 5, name: 'Friday Fish', description: "It's Wisconsin — you know what night it is.", tag: null },
  { day_of_week: 6, name: "Grill Master's Pick", description: "Whatever the kitchen's fired up about.", tag: null },
];
 
const toSpecial = (row: any): Special => ({
  day_of_week: Number(row.day_of_week),
  lunch_name: String(row.lunch_name ?? ''),
  lunch_description: String(row.lunch_description ?? ''),
  lunch_tag: row.lunch_tag || null,
  night_name: String(row.night_name ?? row.name ?? ''),
  night_description: String(row.night_description ?? row.description ?? ''),
  night_tag: row.night_tag ?? row.tag ?? null,
});

// Fallback only fires when D1 is unreachable (astro dev / build with no
// bindings). Mirrors the real model: nine categories, Late Night as a flag.
const FALLBACK_CATEGORIES: Category[] = [
  { id: 1, name: 'Appetizers', sort: 0 },
  { id: 2, name: 'Baskets', sort: 1 },
  { id: 3, name: 'Sandwiches', sort: 2 },
  { id: 4, name: 'Burgers', sort: 3 },
  { id: 5, name: 'Wraps', sort: 4 },
  { id: 6, name: 'Pizzas', sort: 5 },
  { id: 7, name: 'Salads', sort: 6 },
  { id: 8, name: 'Loaded Tot Baskets', sort: 7 },
  { id: 9, name: 'On The Lighter Side', sort: 8 },
];
 
const FALLBACK_ITEMS: Item[] = [
  { id: 1, category_id: 1, name: 'French Fries', description: '', sort: 0, active: 1, photo_key: null, late_night: 1 },
  { id: 2, category_id: 1, name: 'Cheese Curds', description: 'White, yellow or jalapeno.', sort: 1, active: 1, photo_key: null, late_night: 1 },
  { id: 3, category_id: 1, name: 'Big Pretzel', description: '', sort: 2, active: 1, photo_key: null, late_night: 1 },
  { id: 4, category_id: 2, name: 'Chicken Strip Basket', description: 'Served with French fries & toast.', sort: 0, active: 1, photo_key: null, late_night: 0 },
  { id: 5, category_id: 3, name: "Grayz'n Chicken", description: 'Ham, cheddar and Swiss cheese, BBQ sauce.', sort: 0, active: 1, photo_key: null, late_night: 0 },
  { id: 6, category_id: 4, name: "Grayz'n Burger", description: 'Ham, cheddar and Swiss cheese, BBQ sauce.', sort: 0, active: 1, photo_key: null, late_night: 0 },
  { id: 7, category_id: 5, name: 'Chicken Bacon Ranch', description: 'Bacon, lettuce, cheddar cheese, ranch dressing.', sort: 0, active: 1, photo_key: null, late_night: 0 },
  { id: 8, category_id: 6, name: 'Cheese', description: '', sort: 0, active: 1, photo_key: null, late_night: 1 },
  { id: 9, category_id: 6, name: 'Pizza Fries', description: '', sort: 1, active: 1, photo_key: null, late_night: 1 },
  { id: 10, category_id: 7, name: 'Side Salad', description: 'Tomato, onion, cucumber, green pepper, cheddar cheese, hard-boiled egg.', sort: 0, active: 1, photo_key: null, late_night: 0 },
  { id: 11, category_id: 8, name: 'Philly Tots', description: 'Tots, philly meat, onion, mushrooms, green peppers, nacho cheese.', sort: 0, active: 1, photo_key: null, late_night: 0 },
  { id: 12, category_id: 9, name: 'Chicken Quesadilla', description: '', sort: 0, active: 1, photo_key: null, late_night: 0 },
];
 
export async function getSpecials(env: any): Promise<Special[]> {
  try {
    const { results } = await env.DB.prepare(
      'SELECT day_of_week, lunch_name, lunch_description, lunch_tag, night_name, night_description, night_tag FROM specials ORDER BY day_of_week'
    ).all();
    if (results?.length) return results.map(toSpecial);
  } catch {}
  return FALLBACK_SPECIALS.map(toSpecial);
}

export async function getMenu(env: any): Promise<{ categories: Category[]; items: Item[] }> {
  try {
    const cats = await env.DB.prepare('SELECT * FROM categories ORDER BY sort').all();
    const items = await env.DB.prepare('SELECT * FROM items WHERE active = 1 ORDER BY category_id, sort').all();
    if (cats.results?.length) return { categories: cats.results as Category[], items: (items.results ?? []) as Item[] };
  } catch {}
  return { categories: FALLBACK_CATEGORIES, items: FALLBACK_ITEMS };
}

const FALLBACK_WELCOME_PHOTOS: WelcomePhoto[] = [1, 2, 3, 4].map((slot) => ({
  slot,
  photo_key: null,
  alt: '',
  caption: '',
}));

export async function getWelcomePhotos(env: any): Promise<WelcomePhoto[]> {
  try {
    const { results } = await env.DB.prepare(
      'SELECT slot, photo_key, alt, caption FROM welcome_photos WHERE slot BETWEEN 1 AND 4 ORDER BY slot'
    ).all();
    const bySlot = new Map((results ?? []).map((row: any) => [Number(row.slot), row]));
    return FALLBACK_WELCOME_PHOTOS.map((fallback) => {
      const row: any = bySlot.get(fallback.slot);
      return row
        ? {
            slot: fallback.slot,
            photo_key: typeof row.photo_key === 'string' ? row.photo_key : null,
            alt: typeof row.alt === 'string' ? row.alt : '',
            caption: typeof row.caption === 'string' ? row.caption : '',
          }
        : fallback;
    });
  } catch {}
  return FALLBACK_WELCOME_PHOTOS;
}
 
export async function getSetting(env: any, key: string, fallback = ''): Promise<string> {
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first();
    if (row && typeof (row as any).value === 'string') return (row as any).value;
  } catch {}
  return fallback;
}
 
export async function setSetting(env: any, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2'
  ).bind(key, value).run();
}
