// D1 helpers with graceful fallback so dev/build works before provisioning.
export type Special = { day_of_week: number; name: string; description: string; tag: string | null };
export type Item = { id: number; category_id: number; name: string; description: string; sort: number; active: number };
export type Category = { id: number; name: string; sort: number };

const FALLBACK_SPECIALS: Special[] = [
  { day_of_week: 0, name: 'Broasted Chicken Dinner', description: 'Golden broasted chicken with all the fixings.', tag: null },
  { day_of_week: 1, name: 'Burger & Basket Night', description: "Grayz'n Burger with a basket of waffle fries.", tag: null },
  { day_of_week: 2, name: 'Mexican Night', description: 'Tacos, quesadillas, and wet burritos.', tag: 'Mexican Night' },
  { day_of_week: 3, name: 'Grilled Chicken Salad', description: "Plus the Grayz'n Burger with a side.", tag: null },
  { day_of_week: 4, name: 'Soup & Sandwich', description: "Cup of the day's soup with a grilled sandwich.", tag: null },
  { day_of_week: 5, name: 'Friday Fish', description: "It's Wisconsin — you know what night it is.", tag: null },
  { day_of_week: 6, name: "Grill Master's Pick", description: "Whatever the kitchen's fired up about.", tag: null },
];

export async function getSpecials(env: any): Promise<Special[]> {
  try {
    const { results } = await env.DB.prepare('SELECT day_of_week, name, description, tag FROM specials ORDER BY day_of_week').all();
    if (results?.length) return results as Special[];
  } catch {}
  return FALLBACK_SPECIALS;
}

export async function getMenu(env: any): Promise<{ categories: Category[]; items: Item[] }> {
  try {
    const cats = await env.DB.prepare('SELECT * FROM categories ORDER BY sort').all();
    const items = await env.DB.prepare('SELECT * FROM items WHERE active = 1 ORDER BY sort').all();
    if (cats.results?.length) return { categories: cats.results as Category[], items: (items.results ?? []) as Item[] };
  } catch {}
  return {
    categories: [ { id: 1, name: 'Daily', sort: 0 }, { id: 2, name: 'Late Night', sort: 1 } ],
    items: [
      { id: 1, category_id: 1, name: "Grayz'n Burger", description: 'Half-pound burger with your choice of side.', sort: 0, active: 1 },
      { id: 2, category_id: 1, name: 'Grilled Chicken Salad', description: 'Grilled chicken over fresh greens.', sort: 1, active: 1 },
      { id: 3, category_id: 1, name: 'Broasted Chicken', description: 'Golden broasted chicken.', sort: 2, active: 1 },
      { id: 4, category_id: 1, name: 'Soft Pretzel & Cheese', description: 'Warm pretzel with cheese sauce.', sort: 3, active: 1 },
      { id: 5, category_id: 2, name: 'Pizza', description: 'Hot from the oven after the grill closes.', sort: 0, active: 1 },
      { id: 6, category_id: 2, name: 'Pizza Fries', description: 'The late-night favorite.', sort: 1, active: 1 },
      { id: 7, category_id: 2, name: 'Appetizers', description: "Ask what's in the fryer tonight.", sort: 2, active: 1 },
    ],
  };
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
