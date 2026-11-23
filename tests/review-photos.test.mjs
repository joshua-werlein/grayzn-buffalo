import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import sharp from 'sharp';
import { unstable_splitSqlQuery } from 'wrangler';
import { adminSessionEnv } from './admin-session-fixture.mjs';
import { loadTs } from './load-ts.mjs';

const { POST: submit } = loadTs('src/pages/api/review-photos.ts');
const { POST: moderate } = loadTs('src/pages/admin/review-action.ts');
const { GET: image } = loadTs('src/pages/admin/review-image/[id]/[size].ts');
const { GET: oldImage } = loadTs('src/pages/img/[...key].ts');
const { GET: oldPrivateImage } = loadTs('src/pages/admin/img/[...key].ts');
const { reviewCsrf, reviewObjectKey } = loadTs('src/lib/review-preview.ts');
const localOrigin = 'http://127.0.0.1:4396';
const productionOrigin = 'https://grayznbuffalo.com';
const authenticated = { get: () => ({ value: 'a'.repeat(32) }) };
const anonymous = { get: () => undefined };
const anotherSession = { get: () => ({ value: 'b'.repeat(32) }) };

const source = (name = 'photo1') => sharp(`public/images/welcome/${name}.webp`).resize(1100, 800);
const jpeg = new File([await source().withExif({ IFD0: { ImageDescription: 'Private metadata fixture' } }).jpeg().toBuffer()],
  'food.jpg', { type: 'image/jpeg' });
const png = new File([await source('photo2').png().toBuffer()], 'bar.png', { type: 'image/png' });
const webp = new File([await source('photo3').webp().toBuffer()], 'drinks.webp', { type: 'image/webp' });

async function setup(t, { upgrade = false, production = false } = {}) {
  const origin = production ? productionOrigin : localOrigin;
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch: () => new Response() };',
    compatibilityDate: '2026-01-01',
    d1Databases: ['DB'],
    r2Buckets: ['REVIEW_PHOTOS', 'PHOTOS'],
    images: { binding: 'REVIEW_IMAGES' },
  });
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  const ddl = readFileSync('schema.sql', 'utf8');
  const sql = upgrade ? ddl.split('-- Photos and Reviews moderation and menu associations.')[0] : ddl;
  await DB.batch(unstable_splitSqlQuery(sql).map(statement => DB.prepare(statement)));
  await DB.batch([
    DB.prepare("INSERT INTO categories (id, name) VALUES (1, 'Burgers')"),
    DB.prepare("INSERT INTO items (id, category_id, name, photo_key) VALUES (1, 1, 'Burger', 'menu/1/00000000-0000-0000-0000-000000000001.webp')"),
  ]);
  if (upgrade) {
    const migration = readFileSync('migrations/0029_review_photos.sql', 'utf8');
    await DB.batch(unstable_splitSqlQuery(migration).map(statement => DB.prepare(statement)));
  }
  const env = {
    ...adminSessionEnv(), DB, REVIEW_PHOTOS: await mf.getR2Bucket('REVIEW_PHOTOS'), PHOTOS: await mf.getR2Bucket('PHOTOS'),
    REVIEW_IMAGES: await mf.getImagesBinding('REVIEW_IMAGES'),
    REVIEWS_PREVIEW: production ? 'staff-production' : 'local', TURNSTILE_SECRET: 'dummy',
  };
  let turnstile = 0;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    if (String(input) !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return fetch(input, options);
    turnstile++;
    return Promise.resolve(Response.json({ success: options.body.get('response') === 'pass' }));
  });
  const call = (route, path, { body, cookies = authenticated, host = origin, requestOrigin = host, headers = {}, params = {} } = {}) => {
    const url = new URL(path, host);
    const request = new Request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', origin: requestOrigin, ...headers },
      body,
    });
    return route({ request, url, cookies, locals: { cfEnv: env }, params });
  };
  const upload = async (files = [jpeg], category = 'food') => {
    const form = new FormData();
    form.set('csrf', await reviewCsrf(authenticated, env, 'upload'));
    form.set('category', category);
    form.set('consent', 'yes');
    form.set('cf-turnstile-response', 'pass');
    files.forEach((file, index) => {
      form.append('photo', file);
      form.set(`description${index + 1}`, `Test fixture ${index + 1}`);
    });
    return form;
  };
  const action = async (fields, options) => {
    const form = new URLSearchParams({ csrf: await reviewCsrf(authenticated, env, 'moderate'), ...fields });
    return call(moderate, '/admin/review-action', { body: form, ...options });
  };
  const serve = (id, size, options = {}) => call(image, `/admin/review-image/${id}/${size}${options.query ?? ''}`, {
    ...options, params: { id, size },
  });
  const send = (body, options) => call(submit, '/api/review-photos', { body, ...options });
  return { DB, env, call, upload, send, action, serve, turnstile: () => turnstile };
}

test('preview routes reject missing auth, wrong host, cross-origin and wrong-session form tokens', async t => {
  const f = await setup(t);
  const body = await f.upload();
  const fields = { action: 'approve', photo_id: crypto.randomUUID(), revision: '0', category: 'food', description: 'Test' };
  assert.equal((await f.send(body, { cookies: anonymous })).status, 404);
  assert.equal((await f.send(body, { host: 'https://grayznbuffalo.com' })).status, 404);
  assert.equal((await f.send(body, { requestOrigin: 'https://example.net' })).status, 403);
  assert.equal((await f.action(fields, { cookies: anonymous })).status, 404);
  assert.equal((await f.action(fields, { requestOrigin: 'https://example.net' })).status, 403);
  const wrongToken = await reviewCsrf(anotherSession, f.env, 'moderate');
  assert.equal((await f.action({ ...fields, csrf: wrongToken })).status, 403);
  body.delete('csrf');
  const stale = await f.send(body);
  assert.equal(stale.status, 403);
  assert.deepEqual(await stale.json(), { code: 'stale-form' });
  const nativeStale = await f.send(body, { headers: { accept: 'text/html' } });
  assert.equal(nativeStale.status, 303);
  assert.equal(nativeStale.headers.get('location'), '/reviews?result=stale-form#submit-photo');
  assert.equal(f.turnstile(), 0);
  f.env.REVIEWS_PREVIEW = 'staff-production';
  const production = { host: productionOrigin };
  assert.equal((await f.send(await f.upload(), { ...production, cookies: anonymous })).status, 404);
  assert.equal((await f.action(fields, { ...production, cookies: anonymous })).status, 404);
  assert.equal((await f.serve(fields.photo_id, 'small', { ...production, cookies: anonymous })).status, 404);
  for (const host of [localOrigin, 'http://grayznbuffalo.com', 'https://www.grayznbuffalo.com', 'https://grayznbuffalo.com:444']) {
    assert.equal((await f.send(await f.upload(), { host })).status, 404);
  }
  assert.equal((await f.send(await f.upload(), { ...production, requestOrigin: 'https://www.grayznbuffalo.com' })).status, 403);
  delete f.env.REVIEWS_PREVIEW;
  assert.equal((await f.send(await f.upload(), production)).status, 404);
  assert.equal((await f.action(fields)).status, 404);
  assert.equal((await f.serve(fields.photo_id, 'small')).status, 404);
});

test('bounded request, consent, malformed content and Turnstile checks leave no records or objects', async t => {
  const f = await setup(t);
  const tooBig = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.jpg', { type: 'image/jpeg' });
  assert.equal((await f.send(await f.upload([tooBig]))).status, 413);
  assert.equal((await f.send(await f.upload([webp, png, jpeg, png]))).status, 400);
  const bigBody = new Uint8Array(16 * 1024 * 1024);
  assert.equal((await f.send(bigBody, { headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '1' } })).status, 413);
  const missingConsent = await f.upload();
  missingConsent.delete('consent');
  assert.equal((await f.send(missingConsent)).status, 400);
  const bot = await f.upload();
  bot.set('cf-turnstile-response', 'invalid');
  assert.equal((await f.send(bot)).status, 403);
  const garbage = new File([new Uint8Array([255, 216, 255, 255, 217])], 'bad.jpg', { type: 'image/jpeg' });
  const jpegBytes = new Uint8Array(await jpeg.arrayBuffer());
  const truncated = new File([jpegBytes.subarray(0, Math.floor(jpegBytes.length / 2)), jpegBytes.subarray(-2)], 'truncated.jpg', { type: 'image/jpeg' });
  const disguised = new File([jpeg], 'wrong.png', { type: 'image/png' });
  for (const bad of [garbage, truncated, disguised]) {
    assert.equal((await f.send(await f.upload([webp, bad]))).status, 400, bad.name);
  }
  const oversizeModeration = new URLSearchParams({ action: 'edit', description: 'x'.repeat(9000) });
  assert.equal((await f.call(moderate, '/admin/review-action', { body: oversizeModeration })).status, 413);
  assert.equal(await f.DB.prepare('SELECT count(*) FROM review_photos').first('count(*)'), 0);
  assert.equal((await f.env.REVIEW_PHOTOS.list()).objects.length, 0);
});

test('D1 and R2 handle all formats, private originals, duplicate races, review transitions and menu revocation', async t => {
  const f = await setup(t, { upgrade: true, production: true });
  const sendThree = await f.upload([jpeg, png, webp]);
  const submissions = await Promise.all([f.send(sendThree), f.send(sendThree)]);
  assert.deepEqual(submissions.map(response => response.status).sort(), [201, 409]);
  const { results } = await f.DB.prepare('SELECT * FROM review_photos ORDER BY description').all();
  assert.equal(results.length, 3);
  assert.equal(new Set(results.map(row => row.submission_id)).size, 1);
  assert.ok(results.every(row => row.status === 'pending' && row.revision === 0));
  assert.equal((await f.env.REVIEW_PHOTOS.list()).objects.length, 12);
  const [first, second, third] = results.map(row => row.id);
  const file = await f.env.REVIEW_PHOTOS.get(reviewObjectKey(first, 'original'));
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(await jpeg.arrayBuffer()));
  const configuredPreview = await f.serve(first, 'medium', { query: '?moderation=1' });
  assert.equal(configuredPreview.status, 200);
  assert.match(configuredPreview.headers.get('cache-control'), /private, no-store/);
  assert.equal(configuredPreview.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  assert.equal(configuredPreview.headers.get('vary'), 'Cookie');
  const medium = Buffer.from(await configuredPreview.arrayBuffer());
  const meta = await sharp(medium).metadata();
  assert.equal(meta.width, 640);
  assert.equal(meta.exif, undefined);
  assert.ok((await sharp(Buffer.from(await jpeg.arrayBuffer())).metadata()).exif);
  assert.equal((await f.serve(first, 'medium')).status, 404);
  assert.equal((await f.serve(first, 'medium', { cookies: anonymous, query: '?moderation=1' })).status, 404);
  assert.equal((await f.serve(first, 'original', { query: '?moderation=1' })).status, 404);
  const pendingKey = reviewObjectKey(first, 'medium');
  assert.equal((await f.call(oldImage, '/img/' + pendingKey, { params: { key: pendingKey } })).status, 404);
  assert.equal((await f.call(oldPrivateImage, '/admin/img/' + pendingKey, { params: { key: pendingKey } })).status, 404);

  const select = (id, revision = '') => f.action({ action: 'feature', item_id: '1', photo_id: id, revision });
  const approve = (id, category = 'food') => f.action({
    action: 'approve', photo_id: id, revision: '0', category, description: 'Approved fixture',
  });
  assert.equal((await select(first)).status, 409);
  const race = await Promise.all([approve(first), approve(first)]);
  assert.deepEqual(race.map(response => response.status).sort(), [200, 409]);
  assert.equal((await f.serve(first, 'small', { headers: { 'if-none-match': '*' } })).status, 200);
  assert.equal((await f.serve(first, 'small', { cookies: anonymous })).status, 404);
  assert.equal((await select(first)).status, 200);
  const assignment = () => f.DB.prepare('SELECT photo_id, revision FROM review_menu_photos WHERE item_id = 1').first();
  const initial = await assignment();
  assert.equal(initial.photo_id, first);

  assert.equal((await approve(second, 'bar')).status, 200);
  assert.equal((await select(second, initial.revision)).status, 409);
  assert.equal((await f.action({ action: 'edit', photo_id: second, revision: '1', category: 'food', description: 'Food fixture' })).status, 200);
  assert.equal((await select(second, initial.revision)).status, 200);
  assert.equal((await select(first, initial.revision)).status, 409);
  const replacement = await assignment();
  assert.equal(replacement.photo_id, second);
  assert.equal((await f.action({ action: 'unfeature', item_id: '1', photo_id: second, revision: replacement.revision })).status, 200);
  assert.equal(await assignment(), null);
  assert.equal((await f.serve(second, 'large')).status, 200);

  assert.equal((await select(first)).status, 200);
  assert.equal((await f.action({ action: 'reject', photo_id: third, revision: '0' })).status, 200);
  assert.equal((await f.serve(third, 'medium', { query: '?moderation=1' })).status, 404);
  assert.equal(await f.env.REVIEW_PHOTOS.get(reviewObjectKey(third, 'original')), null);
  assert.equal((await f.action({ action: 'withdraw', photo_id: first, revision: '1' })).status, 200);
  assert.equal(await assignment(), null);
  assert.equal((await f.serve(first, 'small', { headers: { 'if-none-match': '*' } })).status, 404);
  const legacy = await f.DB.prepare('SELECT photo_key FROM items WHERE id = 1').first('photo_key');
  assert.equal(legacy, 'menu/1/00000000-0000-0000-0000-000000000001.webp');
  assert.equal((await select(second)).status, 200);
  assert.equal((await f.action({ action: 'edit', photo_id: second, revision: '2', category: 'drinks', description: 'Changed category' })).status, 200);
  assert.equal(await assignment(), null);
});

test('rejecting a submission removes every still-pending photo and keeps prior approvals', async t => {
  const f = await setup(t);
  assert.equal((await f.send(await f.upload([jpeg, png, webp]))).status, 201);
  const { results } = await f.DB.prepare('SELECT id FROM review_photos ORDER BY description').all();
  const [approved, anchor, pending] = results.map(photo => photo.id);
  assert.equal((await f.action({
    action: 'approve', photo_id: approved, revision: '0', category: 'food', description: 'Approved fixture',
  })).status, 200);
  const reject = { action: 'reject-submission', photo_id: anchor, revision: '0' };
  assert.equal((await f.action(reject)).status, 200);
  assert.equal((await f.action(reject)).status, 409);
  assert.equal((await f.serve(approved, 'small')).status, 200);
  for (const id of [anchor, pending]) {
    assert.equal((await f.serve(id, 'medium', { query: '?moderation=1' })).status, 404);
    assert.equal(await f.env.REVIEW_PHOTOS.get(reviewObjectKey(id, 'original')), null);
  }
});

test('browser-style single upload ignores blank optional file controls and reports success or failure', async t => {
  const f = await setup(t);
  const single = await f.upload([jpeg]);
  single.append('photo', new File([], '', { type: 'application/octet-stream' }));
  // Workerd presents a browser's filename="" control as empty text.
  single.append('photo', '');
  const failed = await f.upload([new File(['invalid'], 'invalid.jpg', { type: 'image/jpeg' })]);
  const invalid = await f.send(failed, { headers: { accept: 'text/html' } });
  assert.equal(invalid.status, 303);
  assert.equal(invalid.headers.get('location'), '/reviews?result=invalid-photo#submit-photo');
  const success = await f.send(single);
  assert.equal(success.status, 201);
  assert.deepEqual(await success.json(), { code: 'submitted' });
  assert.equal(await f.DB.prepare("SELECT COUNT(*) AS n FROM review_photos WHERE status = 'pending'").first('n'), 1);
});
