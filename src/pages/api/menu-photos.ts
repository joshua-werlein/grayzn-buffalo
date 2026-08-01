import type { APIRoute } from 'astro';
import { isAuthed } from '../../lib/auth';
import { thumbKey } from '../../lib/db';

export const prerender = false;

const MAX_UPLOAD = 10 * 1024 * 1024; // the client sends ~60 KB; this is a floor, not a target

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Remove both variants. Never throws — an orphaned object is not worth
 *  failing the request over. */
async function dropPhoto(env: any, key: string | null | undefined) {
  if (!key || !env.PHOTOS) return;
  await Promise.allSettled([
    env.PHOTOS.delete(key),
    env.PHOTOS.delete(thumbKey(key)),
  ]);
}

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const env = (locals as any).runtime?.env ?? {};

  if (!(await isAuthed(cookies, env))) {
    return json({ ok: false, error: 'Your session expired. Reload the page and sign in again.' }, 401);
  }
  if (!env.PHOTOS) {
    return json({ ok: false, error: 'Photo storage is not connected yet.' }, 503);
  }

  try {
    const f = await request.formData();
    const id = Number(f.get('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return json({ ok: false, error: 'That item could not be found. Reload the page.' }, 400);
    }

    // ---- remove -------------------------------------------------------
    if (f.get('remove') === '1') {
      const row: any = await env.DB.prepare('SELECT photo_key FROM items WHERE id = ?1').bind(id).first();
      await env.DB.prepare('UPDATE items SET photo_key = NULL WHERE id = ?1').bind(id).run();
      await dropPhoto(env, row?.photo_key);
      return json({ ok: true, removed: true, message: 'Photo removed.' });
    }

    // ---- upload -------------------------------------------------------
    const full = f.get('full');
    const thumb = f.get('thumb');

    if (!(full instanceof File) || !(thumb instanceof File)) {
      return json({ ok: false, error: 'No photo came through. Try picking it again.' }, 400);
    }
    if (full.size > MAX_UPLOAD || thumb.size > MAX_UPLOAD) {
      return json({ ok: false, error: 'That photo is too big. Try a smaller one.' }, 413);
    }
    if (full.type !== 'image/webp' || thumb.type !== 'image/webp') {
      return json({ ok: false, error: 'That photo was not converted properly. Reload the page and try again.' }, 400);
    }

    const previous: any = await env.DB.prepare('SELECT photo_key FROM items WHERE id = ?1').bind(id).first();
    const key = `menu/${id}/${crypto.randomUUID()}.webp`;
    const meta = { httpMetadata: { contentType: 'image/webp' } };

    // Write new, point the row at it, then clean up the old. In that order a
    // failure leaves an orphaned object rather than a row with a dead key.
    await env.PHOTOS.put(key, await full.arrayBuffer(), meta);
    await env.PHOTOS.put(thumbKey(key), await thumb.arrayBuffer(), meta);
    await env.DB.prepare('UPDATE items SET photo_key = ?1 WHERE id = ?2').bind(key, id).run();
    await dropPhoto(env, previous?.photo_key);

    return json({
      ok: true,
      key,
      thumbUrl: `/img/${thumbKey(key)}`,
      fullUrl: `/img/${key}`,
      message: 'Photo saved.',
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? 'Upload failed. Check your connection and try again.' }, 500);
  }
};