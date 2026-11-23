import assert from 'node:assert/strict';
import test from 'node:test';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { adminSessionEnv } from './admin-session-fixture.mjs';
import { builtRoute } from './built-output.mjs';
import { loadTs } from './load-ts.mjs';

const container = await AstroContainer.create();
const manage = (await builtRoute('admin/reviews')).default;
const legacy = (await builtRoute('admin/welcome-photos')).default;
const gallery = (await builtRoute('reviews')).default;
const { uploadMessage, uploadResult } = loadTs('src/lib/review-feedback.ts');
const origin = 'https://grayznbuffalo.com';
const cookie = 'gb_session=' + 'a'.repeat(32);
const photoId = '01910000-1234-4010-8012-000000000001';
function envWithPhotos(food = []) {
  const prepare = sql => ({
    bind() { return this; },
    async first() { return null; },
    async all() {
      if (sql.includes('FROM welcome_photos')) return { results: [{ slot: 1, alt: 'Existing description', caption: 'Existing caption', orientation: 'landscape' }] };
      if (sql.includes('FROM items i')) return { results: [{ id: 17, name: 'Test burger', category: 'Burgers' }] };
      if (sql.includes("status = 'approved' AND category = 'food'")) return { results: food };
      return { results: [] };
    },
  });
  return {
    ...adminSessionEnv(),
    DB: { prepare, withSession: () => ({ prepare }) },
    REVIEWS_PREVIEW: 'staff-production',
    REVIEW_PHOTOS: {},
    REVIEW_IMAGES: {},
    TURNSTILE_SITEKEY: 'test-sitekey',
    TURNSTILE_SECRET: 'test-secret',
  };
}
function render(page, path, env, signedIn = true) {
  return container.renderToResponse(page, {
    request: new Request(origin + path, { headers: signedIn ? { cookie } : {} }),
    locals: { runtime: { env } },
  });
}

test('upload result handling covers success, Turnstile, expired forms, edge errors and unexpected responses', async () => {
  for (const [status, body, expected] of [
    [201, { code: 'submitted' }, 'submitted'],
    [403, { code: 'verification' }, 'verification'],
    [403, { code: 'stale-form' }, 'stale-form'],
    [409, { code: 'duplicate' }, 'duplicate'],
    [500, { code: 'submitted' }, 'unavailable'],
    [200, { code: 'submitted' }, 'unavailable'],
    [403, 'Forbidden', 'stale-form'],
    [413, 'edge limit', 'too-large'],
    [404, 'Not found', 'session'],
    [502, '<html>bad gateway</html>', 'unavailable'],
  ]) {
    const response = typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status });
    assert.equal(await uploadResult(response), expected);
    assert.ok(uploadMessage(expected));
  }
  assert.equal(uploadMessage('toString'), '');
});

test('private gallery serves accessible live regions and native success and error feedback', async () => {
  const env = envWithPhotos();
  assert.equal((await render(gallery, '/reviews', env, false)).status, 404);
  for (const [result, role] of [['submitted', 'status'], ['stale-form', 'alert'], ['verification', 'alert']]) {
    const response = await render(gallery, '/reviews?result=' + result, env);
    const html = await response.text();
    assert.match(html, new RegExp('data-upload-fallback[^>]*role="' + role + '"[^>]*>' + uploadMessage(result)));
    assert.match(html, /data-upload-status[^>]*role="status"/);
    assert.match(html, /data-upload-error[^>]*role="alert"/);
  }
});

test('combined admin preserves navigation, authenticated legacy redirect, existing Welcome data, and the menu workflow', async () => {
  const env = envWithPhotos();
  assert.equal((await render(legacy, '/admin/welcome-photos', env, false)).headers.get('location'), '/admin?next=/admin/welcome-photos');
  assert.equal((await render(legacy, '/admin/welcome-photos', env)).headers.get('location'), '/admin/reviews#welcome-photos');
  const html = await (await render(manage, '/admin/reviews', env)).text();
  assert.ok(html.indexOf('Customer Photo Moderation') < html.indexOf('Featured Menu Photos'));
  assert.ok(html.indexOf('Featured Menu Photos') < html.indexOf('Welcome Photos'));
  assert.match(html, /href="#menu-assignment"[^>]*>Feature a menu photo/);
  assert.match(html, /id="menu-assignment"[^>]*tabindex="-1"/);
  assert.match(html, /No approved Food photos are available/);
  assert.match(html, /href="\/admin\/reviews" aria-current="page"[^>]*>Photos/);
  assert.match(html, /Existing caption/);
  const eligible = envWithPhotos([{ id: photoId, description: 'Approved pretzel' }]);
  const assigned = await (await render(manage, '/admin/reviews?item=17', eligible)).text();
  assert.match(assigned, /name="item_id" value="17"/);
  assert.match(assigned, /Approved pretzel/);
  assert.match(assigned, /value="feature"/);
  delete env.REVIEWS_PREVIEW;
  const welcomeOnly = await (await render(manage, '/admin/reviews', env)).text();
  assert.doesNotMatch(welcomeOnly, /Customer Photo Moderation|Featured Menu Photos/);
  assert.match(welcomeOnly, /Existing caption/);
});
