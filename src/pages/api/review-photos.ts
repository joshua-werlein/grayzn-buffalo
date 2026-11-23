import type { APIRoute } from 'astro';
import { isAuthed, verifyTurnstile } from '../../lib/auth';
import { BodyTooLarge, readFormData } from '../../lib/request-body';
import {
  InvalidReviewImage, MAX_REVIEW_PHOTO_BYTES, MAX_REVIEW_PHOTOS, MAX_REVIEW_REQUEST_BYTES,
  discardReviewImage, prepareReviewImage, storeReviewImage,
} from '../../lib/review-images';
import {
  reviewCategory, reviewCsrfMatches, reviewDescription, reviewFormFeedback, reviewOriginMatches,
  reviewPreviewEnabled, reviewResponse,
} from '../../lib/review-preview';
import { runtimeEnv } from '../../lib/runtime-env';

type SubmissionPhoto = { id: string; digest: string; small: number; medium: number; height: number };

export const POST: APIRoute = async ({ request, url, cookies, locals }) => {
  const env = runtimeEnv(locals);
  if (!reviewPreviewEnabled(url, env) || !await isAuthed(cookies, env)) return reviewResponse('Not found', 404);
  if (!reviewOriginMatches(request, url)) return reviewResponse('Forbidden', 403);
  const feedback = (code: string, status: number, stage = code) => {
    if (status >= 400) {
      const ray = request.headers.get('cf-ray') ?? '';
      // Log fixed classifications only. Photo content, form fields, and upstream errors stay private.
      console.warn({ event: 'review_upload_failed', stage, code, status, ray: /^[a-f0-9]{16}-[A-Z]{3}$/i.test(ray) ? ray : undefined });
    }
    return reviewFormFeedback(request, '/reviews#submit-photo', code, status);
  };
  if (!env.DB || !env.REVIEW_PHOTOS || !env.REVIEW_IMAGES || !env.TURNSTILE_SECRET) {
    return feedback('unavailable', 503, 'bindings');
  }
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return feedback('invalid-form', 400, 'content-type');
  }

  let form: FormData;
  try {
    form = await readFormData(request, MAX_REVIEW_REQUEST_BYTES);
  } catch (error) {
    return error instanceof BodyTooLarge ? feedback('too-large', 413, 'request-size') : feedback('invalid-form', 400, 'multipart');
  }
  if (!await reviewCsrfMatches(form, cookies, env, 'upload')) return feedback('stale-form', 403, 'csrf');
  const fields = form.getAll('photo');
  const photos = fields.map((file, index) => ({ file, description: reviewDescription(form.get(`description${index + 1}`)) }))
    // Workerd parses multipart filename="" as an empty text field. Other
    // runtimes return an empty File for the same unselected browser control.
    .filter(({ file }) => file !== '' && !(file instanceof File && !file.name && !file.size));
  const category = form.get('category');
  if (!photos.length || fields.length > MAX_REVIEW_PHOTOS || !reviewCategory(category)
      || form.get('consent') !== 'yes'
      || !photos.every((photo): photo is { file: File; description: string } =>
        photo.file instanceof File && Boolean(photo.description) && photo.file.size > 0)) {
    return feedback('invalid-form', 400);
  }
  if (photos.some(({ file }) => file.size > MAX_REVIEW_PHOTO_BYTES)) return feedback('too-large', 413, 'file-size');
  const token = form.get('cf-turnstile-response');
  if (typeof token !== 'string' || !token || token.length > 2048
      || !await verifyTurnstile(token, env, request.headers.get('CF-Connecting-IP') ?? undefined)) {
    return feedback('verification', 403, 'turnstile');
  }

  const stored: SubmissionPhoto[] = [];
  const submitted = crypto.randomUUID();
  const cleanup = async () => {
    const deleted = await Promise.allSettled(stored.map(({ id }) => discardReviewImage(env.REVIEW_PHOTOS, id)));
    if (deleted.some(result => result.status === 'rejected')) console.warn({ event: 'review_upload_cleanup_incomplete' });
  };
  let stage = 'image';
  try {
    for (const { file } of photos) {
      stage = 'image';
      const image = await prepareReviewImage(file, env.REVIEW_IMAGES);
      if (stored.some(photo => photo.digest === image.digest)) {
        await cleanup();
        return feedback('duplicate', 409);
      }
      const id = crypto.randomUUID();
      stored.push({ id, digest: image.digest, small: image.small.width, medium: image.medium.width, height: image.medium.height });
      stage = 'r2-write';
      await storeReviewImage(env.REVIEW_PHOTOS, id, image);
    }
  } catch (error) {
    await cleanup();
    return error instanceof InvalidReviewImage
      ? feedback('invalid-photo', 400, error.stage) : feedback('unavailable', 503, stage);
  }

  try {
    await env.DB.batch(stored.map((photo, index) => env.DB.prepare(
      `INSERT INTO review_photos
        (id, submission_id, digest, category, description, small_width, medium_width, medium_height)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(photo.id, submitted, photo.digest, category, photos[index].description, photo.small, photo.medium, photo.height)));
  } catch {
    try {
      // A transport failure can occur after a successful atomic batch. Keep
      // referenced objects and leave unknown outcomes for reconciliation.
      const session = env.DB.withSession('first-primary');
      const own = await session.prepare('SELECT id FROM review_photos WHERE submission_id = ?').bind(submitted).first();
      if (own) return feedback('submitted', 201);
      const placeholders = stored.map(() => '?').join(', ');
      const duplicate = await session.prepare(
        `SELECT id FROM review_photos WHERE digest IN (${placeholders}) AND status IN ('pending', 'approved') LIMIT 1`,
      ).bind(...stored.map(photo => photo.digest)).first();
      if (duplicate) {
        await cleanup();
        return feedback('duplicate', 409);
      }
    } catch {}
    return feedback('unavailable', 503, 'd1-insert');
  }
  return feedback('submitted', 201);
};
