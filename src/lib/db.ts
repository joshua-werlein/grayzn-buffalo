import menuBaseline from '../data/menu-baseline.json';
// D1 helpers with graceful fallback so dev/build works before provisioning.
export type Special = {
  day_of_week: number;
  lunch_name: string;
  lunch_description: string;
  lunch_tag: string | null;
  night_name: string;
  night_description: string;
  night_tag: string | null;
  allday_name: string;
  allday_description: string;
  allday_tag: string | null;
};
export type PhotoOrientation = 'portrait' | 'square' | 'landscape';
export type Item = { id: number; category_id: number; name: string; description: string; sort: number; active: number; photo_key: string | null; late_night: number; photo_orientation?: PhotoOrientation };
export type Category = { id: number; name: string; sort: number; subtitle?: string; note?: string };
export type WelcomePhoto = { slot: number; photo_key: string | null; alt: string; caption: string; orientation: PhotoOrientation };
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
  allday_name: String(row.allday_name ?? ''),
  allday_description: String(row.allday_description ?? ''),
  allday_tag: row.allday_tag ?? null,
});

// Emergency fallback uses the verified production recovery snapshot.
const FALLBACK_CATEGORIES: Category[] = menuBaseline.categories;
const FALLBACK_ITEMS: Item[] = menuBaseline.items.map(item => ({ ...item, description: item.description ?? '', photo_orientation: item.photo_orientation as PhotoOrientation }));

export async function getSpecials(env: any): Promise<Special[]> {
  try {
    const { results } = await env.DB.prepare(
      'SELECT day_of_week, lunch_name, lunch_description, lunch_tag, night_name, night_description, night_tag, allday_name, allday_description, allday_tag FROM specials ORDER BY day_of_week'
    ).all();
    if (results?.length) return results.map(toSpecial);
  } catch {}
  return FALLBACK_SPECIALS.map(toSpecial);
}

export type WeeklySpecial = {
  id: number;
  week_start_date: string;
  week_end_date: string;
  created_at: string;
  updated_at: string;
  days: WeeklySpecialDay[];
};

export type WeeklySpecialDay = {
  day_of_week: number;
  lunch_content: string;
  all_day_1_content: string;
  all_day_2_content: string;
  nightly_content: string;
};

export type ApplicableWeeklySpecial =
  | { status: 'current'; special: WeeklySpecial }
  | { status: 'expired'; special: WeeklySpecial }
  | { status: 'missing' };

function toWeeklySpecial(row: any, days: WeeklySpecialDay[]): WeeklySpecial {
  return {
    id: Number(row.id),
    week_start_date: String(row.week_start_date),
    week_end_date: String(row.week_end_date),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    days,
  };
}

async function weeklySpecialWithDays(env: any, row: any): Promise<WeeklySpecial> {
  const { results } = await env.DB.prepare(
    `SELECT day_of_week, lunch_content, all_day_1_content, all_day_2_content, nightly_content
     FROM weekly_special_days WHERE weekly_special_id = ?1 ORDER BY day_of_week`,
  ).bind(row.id).all();
  const days = (results ?? []).map((day: any) => ({
    day_of_week: Number(day.day_of_week),
    lunch_content: String(day.lunch_content ?? ''),
    all_day_1_content: String(day.all_day_1_content ?? ''),
    all_day_2_content: String(day.all_day_2_content ?? ''),
    nightly_content: String(day.nightly_content ?? ''),
  }));
  return toWeeklySpecial(row, days);
}

/** Returns a current entry, or the most recently expired one for an honest notice. */
export async function getApplicableWeeklySpecial(env: any, calendarDate: string): Promise<ApplicableWeeklySpecial> {
  try {
    const current = await env.DB.prepare(
      `SELECT id, week_start_date, week_end_date, created_at, updated_at
       FROM weekly_specials
       WHERE week_start_date <= ?1 AND week_end_date >= ?1
       ORDER BY week_start_date DESC
       LIMIT 1`,
    ).bind(calendarDate).first();
    if (current) return { status: 'current', special: await weeklySpecialWithDays(env, current) };

    const expired = await env.DB.prepare(
      `SELECT id, week_start_date, week_end_date, created_at, updated_at
       FROM weekly_specials
       WHERE week_end_date < ?1
       ORDER BY week_end_date DESC
       LIMIT 1`,
    ).bind(calendarDate).first();
    if (expired) return { status: 'expired', special: await weeklySpecialWithDays(env, expired) };
  } catch {}
  return { status: 'missing' };
}

/** Returns every saved weekly-special record that overlaps the requested calendar range. */
export async function getWeeklySpecialsForDateRange(env: any, startDate: string, endDate: string): Promise<WeeklySpecial[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, week_start_date, week_end_date, created_at, updated_at
       FROM weekly_specials
       WHERE week_start_date <= ?2 AND week_end_date >= ?1
       ORDER BY week_start_date ASC`,
    ).bind(startDate, endDate).all();
    return Promise.all((results ?? []).map((row: any) => weeklySpecialWithDays(env, row)));
  } catch {}
  return [];
}

export async function getMenu(env: any): Promise<{ categories: Category[]; items: Item[] }> {
  try {
    const cats = await env.DB.prepare('SELECT * FROM categories ORDER BY sort').all();
    const items = await env.DB.prepare('SELECT * FROM items WHERE active = 1 ORDER BY category_id, sort').all();
    if (cats.results?.length) return { categories: cats.results as Category[], items: (items.results ?? []) as Item[] };
  } catch {}
  return { categories: FALLBACK_CATEGORIES, items: FALLBACK_ITEMS.filter(item => item.active === 1) };
}

const FALLBACK_WELCOME_PHOTOS: WelcomePhoto[] = [1, 2, 3, 4].map((slot) => ({
  slot,
  photo_key: null,
  alt: '',
  caption: '',
  orientation: 'portrait',
}));

export async function getWelcomePhotos(env: any): Promise<WelcomePhoto[]> {
  try {
    const { results } = await env.DB.prepare(
      'SELECT slot, photo_key, alt, caption, orientation FROM welcome_photos WHERE slot BETWEEN 1 AND 4 ORDER BY slot'
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
            orientation: row.orientation === 'landscape' || row.orientation === 'square' ? row.orientation : 'portrait',
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
