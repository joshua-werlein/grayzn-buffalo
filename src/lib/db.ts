import menuBaseline from '../data/menu-baseline.json';
import { chicagoCalendarDate, isIsoCalendarDate } from './weekly-specials';
// D1 helpers with graceful fallback so dev/build works before provisioning.
export type PhotoOrientation = 'portrait' | 'square' | 'landscape';
export type Item = { id: number; category_id: number; name: string; description: string; sort: number; active: number; photo_key: string | null; late_night: number; photo_orientation?: PhotoOrientation };
export type Category = { id: number; name: string; sort: number; subtitle?: string; note?: string };
export type WelcomePhoto = { slot: number; photo_key: string | null; alt: string; caption: string; orientation: PhotoOrientation };
export const thumbKey = (key: string) => key.replace(/\.webp$/, '@600.webp');
 
// Emergency fallback uses the verified production recovery snapshot.
const FALLBACK_CATEGORIES: Category[] = menuBaseline.categories;
const FALLBACK_ITEMS: Item[] = menuBaseline.items.map(item => ({ ...item, description: item.description ?? '', photo_orientation: item.photo_orientation as PhotoOrientation }));

export { getWeeklySpecialsForDateRange, type WeeklySpecial } from './specials-store';

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

/** Only the server chooses the date and increment. Never store a click record. */
export async function incrementFacebookClicks(env: any, now = new Date()): Promise<void> {
  const started = await getSetting(env, 'facebook_click_tracking_started');
  const today = chicagoCalendarDate(now);
  if (!isIsoCalendarDate(started) || started > today) throw new Error('Facebook counter is not enabled.');
  await env.DB.prepare(
    `INSERT INTO facebook_outbound_clicks_daily (date, count) VALUES (?1, 1)
     ON CONFLICT(date) DO UPDATE SET count = facebook_outbound_clicks_daily.count + 1`,
  ).bind(today).run();
}

export async function getFacebookClicks(env: any, start: string, end: string): Promise<
  { status: 'ok'; count: number; started: string } | { status: 'unavailable' | 'not-started' }
> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'facebook_click_tracking_started'").first();
    if (!row || !isIsoCalendarDate(row.value) || row.value > end) return { status: 'not-started' };
    const total = await env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM facebook_outbound_clicks_daily WHERE date >= ?1 AND date <= ?2')
      .bind(start > row.value ? start : row.value, end).first();
    if (!total || !Number.isSafeInteger(total.total) || total.total < 0) return { status: 'unavailable' };
    return { status: 'ok', count: total.total, started: row.value };
  } catch { return { status: 'unavailable' }; }
}
