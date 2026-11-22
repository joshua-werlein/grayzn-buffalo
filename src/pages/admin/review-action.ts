import type { APIRoute } from 'astro';
import { isAuthed } from '../../lib/auth';
import { discardReviewImage } from '../../lib/review-images';
import {
  REVIEW_ID, reviewCategory, reviewCsrfMatches, reviewDescription, reviewFormFeedback, reviewOriginMatches,
  reviewPreviewEnabled, reviewResponse,
} from '../../lib/review-preview';
import { BodyTooLarge, readFormData } from '../../lib/request-body';
import { runtimeEnv } from '../../lib/runtime-env';

const transitions: Record<string, [string, string]> = {
  approve: ['pending', 'approved'],
  reject: ['pending', 'rejected'],
  edit: ['approved', 'approved'],
  withdraw: ['approved', 'withdrawn'],
};

export const POST: APIRoute = async ({ request, url, cookies, locals }) => {
  const env = runtimeEnv(locals);
  if (!reviewPreviewEnabled(url, env) || !await isAuthed(cookies, env)) return reviewResponse('Not found', 404);
  if (!reviewOriginMatches(request, url)) return reviewResponse('Forbidden', 403);
  const feedback = (code: string, status: number, path = '/admin/reviews') => reviewFormFeedback(request, path, code, status);
  if (!env.DB || !env.REVIEW_PHOTOS) return feedback('unavailable', 503);

  let form: FormData;
  try {
    form = await readFormData(request, 8 * 1024);
  } catch (error) {
    return error instanceof BodyTooLarge ? feedback('too-large', 413) : feedback('invalid', 400);
  }
  if (!await reviewCsrfMatches(form, cookies, env, 'moderate')) return reviewResponse('Forbidden', 403);

  const action = form.get('action');
  const id = form.get('photo_id');
  const revision = form.get('revision');
  if (typeof action !== 'string' || typeof id !== 'string' || typeof revision !== 'string') return feedback('invalid', 400);
  try {
    if (action === 'feature' || action === 'unfeature') {
      const item = form.get('item_id');
      if (typeof item !== 'string' || !/^[1-9]\d{0,14}$/.test(item)
          || (revision !== '' && !REVIEW_ID.test(revision))
          || (action === 'feature' && !REVIEW_ID.test(id))) return feedback('invalid', 400);
      const path = `/admin/reviews?item=${item}#menu-assignment`;
      const result = action === 'feature'
        ? await env.DB.prepare(
          `INSERT INTO review_menu_photos (item_id, photo_id, revision)
           SELECT i.id, p.id, ? FROM items i JOIN review_photos p ON p.id = ?
           WHERE i.id = ? AND i.active = 1 AND p.status = 'approved' AND p.category = 'food'
             AND COALESCE((SELECT revision FROM review_menu_photos WHERE item_id = i.id), '') = ?
           ON CONFLICT(item_id) DO UPDATE SET photo_id = excluded.photo_id, revision = excluded.revision`,
        ).bind(crypto.randomUUID(), id, Number(item), revision).run()
        : await env.DB.prepare(
          'DELETE FROM review_menu_photos WHERE item_id = ? AND revision = ?',
        ).bind(Number(item), revision).run();
      return result.meta.changes ? feedback(action, 200, path) : feedback('conflict', 409, path);
    }

    if (!REVIEW_ID.test(id) || !/^\d{1,9}$/.test(revision)) {
      return feedback('invalid', 400);
    }
    if (action === 'reject-submission') {
      // Resolve the anchor once and reject the submission's still-pending
      // photos in the same statement.
      const { results } = await env.DB.prepare(
        `WITH target AS MATERIALIZED (
           SELECT submission_id FROM review_photos WHERE id = ? AND status = 'pending' AND revision = ?
         )
         UPDATE review_photos SET status = 'rejected', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
         WHERE status = 'pending' AND submission_id = (SELECT submission_id FROM target)
         RETURNING id`,
      ).bind(id, Number(revision)).all();
      if (!results.length) return feedback('conflict', 409);
      const cleanup = await Promise.allSettled(results.map((photo: { id: string }) => discardReviewImage(env.REVIEW_PHOTOS, photo.id)));
      return cleanup.some(result => result.status === 'rejected') ? feedback('cleanup', 200) : feedback(action, 200);
    }
    if (!Object.hasOwn(transitions, action)) return feedback('invalid', 400);
    const [from, to] = transitions[action];
    const changesDetails = action === 'approve' || action === 'edit';
    const category = form.get('category');
    const description = reviewDescription(form.get('description'));
    if (changesDetails && (!reviewCategory(category) || !description)) return feedback('invalid', 400);
    const result = await env.DB.prepare(
      `UPDATE review_photos SET status = ?, category = COALESCE(?, category),
       description = COALESCE(?, description), revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = ? AND revision = ?`,
    ).bind(to, changesDetails ? category : null, changesDetails ? description : null, id, from, Number(revision)).run();
    if (!result.meta.changes) return feedback('conflict', 409);
    if (to === 'rejected' || to === 'withdrawn') {
      try {
        await discardReviewImage(env.REVIEW_PHOTOS, id);
      } catch {
        return feedback('cleanup', 200);
      }
    }
    return feedback(action, 200);
  } catch {
    return feedback('unavailable', 503);
  }
};
