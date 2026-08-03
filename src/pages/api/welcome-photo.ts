import type { APIRoute } from 'astro';
import { isAuthed } from '../../lib/auth';
import { thumbKey } from '../../lib/db';

export const prerender = false;

const MAX_UPLOAD = 10 * 1024 * 1024;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

async function dropPhoto(env: any, key: string | null | undefined) {
  if (!key || !env.PHOTOS) return;
  await Promise.allSettled([env.PHOTOS.delete(key), env.PHOTOS.delete(thumbKey(key))]);
}

const slotFrom = (form: FormData) => {
  const slot = Number(form.get('slot'));
  return Number.isInteger(slot) && slot >= 1 && slot <= 4 ? slot : null;
};

const photoOrientation = (form: FormData) => {
  const width = Number(form.get('width'));
  const height = Number(form.get('height'));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'portrait';
  if (width > height * 1.1) return 'landscape';
  if (height > width * 1.1) return 'portrait';
  return 'square';
};

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const env = (locals as any).runtime?.env ?? {};
  if (!(await isAuthed(cookies, env))) {
    return json({ ok: false, error: 'Your session expired. Reload the page and sign in again.' }, 401);
  }
  if (!env.PHOTOS || !env.DB) return json({ ok: false, error: 'Photo storage is not connected yet.' }, 503);

  try {
    const form = await request.formData();
    const slot = slotFrom(form);
    if (!slot) return json({ ok: false, error: 'That photo slot could not be found. Reload the page.' }, 400);

    const alt = String(form.get('alt') ?? '').trim().slice(0, 240);
    const caption = String(form.get('caption') ?? '').trim().slice(0, 120);
    const action = String(form.get('action') ?? 'upload');
    const orientation = photoOrientation(form);

    if (action === 'metadata') {
      await env.DB.prepare(
        'INSERT INTO welcome_photos (slot, alt, caption) VALUES (?1, ?2, ?3) ON CONFLICT(slot) DO UPDATE SET alt = ?2, caption = ?3'
      ).bind(slot, alt, caption).run();
      return json({ ok: true, message: 'Photo details saved.' });
    }

    const previous: any = await env.DB.prepare(
      'SELECT photo_key FROM welcome_photos WHERE slot = ?1'
    ).bind(slot).first();

    if (action === 'remove') {
      await env.DB.prepare(
        'INSERT INTO welcome_photos (slot, photo_key, alt, caption, orientation) VALUES (?1, NULL, ?2, ?3, ?4) ON CONFLICT(slot) DO UPDATE SET photo_key = NULL, alt = ?2, caption = ?3, orientation = ?4'
      ).bind(slot, alt, caption, orientation).run();
      await dropPhoto(env, previous?.photo_key);
      return json({ ok: true, removed: true, message: 'Photo removed.' });
    }

    const full = form.get('full');
    const thumb = form.get('thumb');
    if (!(full instanceof File) || !(thumb instanceof File)) {
      return json({ ok: false, error: 'No photo came through. Try picking it again.' }, 400);
    }
    if (full.size > MAX_UPLOAD || thumb.size > MAX_UPLOAD) {
      return json({ ok: false, error: 'That photo is too big. Try a smaller one.' }, 413);
    }
    if (full.type !== 'image/webp' || thumb.type !== 'image/webp') {
      return json({ ok: false, error: 'That photo was not converted properly. Reload the page and try again.' }, 400);
    }

    const key = `welcome/${crypto.randomUUID()}.webp`;
    const meta = { httpMetadata: { contentType: 'image/webp' } };

    // Write both new objects before D1 points at them; a failure can only
    // leave an orphan, never a Welcome slot that references a missing image.
    await env.PHOTOS.put(key, await full.arrayBuffer(), meta);
    await env.PHOTOS.put(thumbKey(key), await thumb.arrayBuffer(), meta);
    await env.DB.prepare(
      'INSERT INTO welcome_photos (slot, photo_key, alt, caption, orientation) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(slot) DO UPDATE SET photo_key = ?2, alt = ?3, caption = ?4, orientation = ?5'
    ).bind(slot, key, alt, caption, orientation).run();
    await dropPhoto(env, previous?.photo_key);

    return json({
      ok: true,
      fullUrl: `/img/${key}`,
      thumbUrl: `/img/${thumbKey(key)}`,
      message: 'Welcome photo saved.',
    });
  } catch (error: any) {
    return json({ ok: false, error: error?.message ?? 'Upload failed. Check your connection and try again.' }, 500);
  }
};
