import type { APIRoute } from 'astro';
import { isAuthed } from '../../../../lib/auth';
import { REVIEW_HEADERS, REVIEW_ID, reviewObjectKey, reviewPreviewEnabled, reviewResponse } from '../../../../lib/review-preview';
import { runtimeEnv } from '../../../../lib/runtime-env';

export const GET: APIRoute = async ({ cookies, locals, params, url }) => {
  const env = runtimeEnv(locals);
  const id = params.id ?? '';
  const size = params.size;
  if (!reviewPreviewEnabled(url, env) || !REVIEW_ID.test(id)
      || (size !== 'small' && size !== 'medium' && size !== 'large')
      || !await isAuthed(cookies, env)) return reviewResponse('Not found', 404);
  if (!env.DB || !env.REVIEW_PHOTOS) return reviewResponse('Unavailable', 503);
  try {
    const db = env.DB.withSession('first-primary');
    const entry = await db.prepare('SELECT status FROM review_photos WHERE id = ?').bind(id).first();
    const moderation = size === 'medium' && url.searchParams.get('moderation') === '1';
    if (entry?.status !== 'approved' && !(moderation && entry?.status === 'pending')) {
      return reviewResponse('Not found', 404);
    }
    const object = await env.REVIEW_PHOTOS.get(reviewObjectKey(id, size));
    if (!object) return reviewResponse('Not found', 404);
    return new Response(object.body, {
      headers: { ...REVIEW_HEADERS, 'Content-Type': 'image/webp', 'Content-Length': String(object.size) },
    });
  } catch {
    return reviewResponse('Unavailable', 503);
  }
};
