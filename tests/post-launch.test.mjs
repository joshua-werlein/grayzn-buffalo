import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './load-ts.mjs';
const { onRequest } = loadTs('src/middleware.ts');
const { GET: imageGet } = loadTs('src/pages/img/[...key].ts');
const { POST: contactPost } = loadTs('src/pages/api/contact.ts');
const { getWeeklySpecialsForDateRange } = loadTs('src/lib/db.ts');

test('image route and middleware preserve no-store on missing/storage-error images', async () => {
  const key = 'facebook/missing.jpg';
  for (const env of [{}, { PHOTOS: { get: async () => null } }, { PHOTOS: { get: async () => { throw new Error('storage failed'); } } }]) {
    const response = await onRequest({ url: new URL('https://grayznbuffalo.com/img/' + key) }, () =>
      imageGet({ params: { key }, locals: { runtime: { env } }, request: new Request('https://example.com/img/' + key) }));
    assert.ok([404, 503].includes(response.status));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const response = await onRequest({ url: new URL('https://grayznbuffalo.com/img/test') }, async () =>
    new Response('Error', { status: 500, headers: { 'cache-control': 'no-store' } }));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('successful and conditional images retain immutable caching through middleware', async () => {
  for (const conditional of [false, true]) {
    const object = { httpEtag: '"test"', writeHttpMetadata: (headers) => headers.set('content-type', 'image/jpeg') };
    if (!conditional) object.body = 'image';
    const response = await onRequest({ url: new URL('https://grayznbuffalo.com/img/facebook/test.jpg') }, () =>
      imageGet({ params: { key: 'facebook/test.jpg' }, locals: { runtime: { env: { PHOTOS: { get: async () => object } } } }, request: new Request('https://example.com/') }));
    assert.equal(response.status, conditional ? 304 : 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  }
});

const config = { TURNSTILE_SECRET: 'test-secret', RESEND_API_KEY: 'test-key', CONTACT_TO_EMAIL: 'staff@example.com' };
const valid = { name: 'Test', email: 'visitor@example.com', message: 'Hello', 'cf-turnstile-response': 'test-token' };
const submit = (body, env = config) => contactPost({ request: new Request('https://example.com/api/contact', { method: 'POST', body }), locals: { runtime: { env } } });

test('contact rejects malformed/non-object JSON, bad fields, email, and length overflow without fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network call'); });
  const invalid = ['{', 'null', '[]', '42', '"text"', ...[
    {}, { ...valid, name: {} }, { ...valid, email: 'bad' }, { ...valid, message: '  ' },
    { ...valid, name: 'x'.repeat(101) }, { ...valid, email: 'a'.repeat(250) + '@example.com' },
    { ...valid, message: 'x'.repeat(5001) }, { ...valid, 'cf-turnstile-response': '' },
  ].map(JSON.stringify)];
  for (const body of invalid) assert.equal((await submit(body)).status, 400);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('contact fails closed with missing/blank required configuration and never exposes values', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network call'); });
  for (const key of Object.keys(config)) {
    for (const value of [undefined, '  ']) {
      const response = await submit(JSON.stringify(valid), { ...config, [key]: value });
      assert.equal(response.status, 503);
      const text = await response.text();
      for (const secret of Object.values(config)) assert.equal(text.includes(secret), false);
    }
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('Turnstile failures are controlled and cannot reach Resend', async (t) => {
  for (const [label, reply, expected] of [
    ['network', () => { throw new Error('private provider details'); }, 502],
    ['parse', () => new Response('not json'), 502],
    ['api', () => new Response('private provider details', { status: 500 }), 502],
    ['rejected', () => Response.json({ success: false }), 400],
    ['nonboolean', () => Response.json({ success: 'true' }), 400],
  ]) await t.test(label, async (t) => {
    const mocked = t.mock.method(globalThis, 'fetch', async () => reply());
    const response = await submit(JSON.stringify(valid));
    assert.equal(response.status, expected);
    assert.equal((await response.text()).includes('private provider details'), false);
    assert.equal(mocked.mock.callCount(), 1);
  });
});

test('Resend network/API failures return generic errors after verification', async (t) => {
  for (const fail of [() => { throw new Error('private provider details'); }, () => new Response('private provider details', { status: 500 })]) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? Response.json({ success: true }) : fail());
    const response = await submit(JSON.stringify(valid));
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes('private provider details'), false);
    assert.equal(calls, 2);
  }
});

test('valid contact uses only the configured recipient and escapes HTML', async (t) => {
  let mail;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('siteverify')) return Response.json({ success: true });
    assert.equal(url, 'https://api.resend.com/emails');
    mail = JSON.parse(options.body);
    return Response.json({ id: 'mock-message' });
  });
  const response = await submit(JSON.stringify({ ...valid, name: '<b>Test</b>', message: '<script>bad</script>' }));
  assert.equal(response.status, 200);
  assert.deepEqual(mail.to, ['staff@example.com']);
  assert.equal(mail.reply_to, valid.email);
  assert.ok(mail.html.includes('&lt;script&gt;bad&lt;/script&gt;'));
  assert.ok(!mail.html.includes('<script>bad</script>'));
});

function weeklyDb(failDays) {
  return { DB: { prepare: (sql) => ({ bind: () => ({ all: async () => {
    if (sql.includes('FROM weekly_special_days')) {
      await Promise.resolve();
      if (failDays) throw new Error('day load failed');
      return { results: [{ day_of_week: 1, lunch_content: '', all_day_1_content: '', all_day_2_content: '', nightly_content: 'Dinner' }] };
    }
    return { results: [{ id: 1, week_start_date: '2026-09-07', week_end_date: '2026-09-13' }] };
  } }) }) } };
}
test('weekly day-query rejection reaches the public empty-list fallback', async () => {
  assert.deepEqual(await getWeeklySpecialsForDateRange(weeklyDb(true), '2026-09-07', '2026-09-13'), []);
});
test('successful weekly loads retain their shape and intentional blanks', async () => {
  const weeks = await getWeeklySpecialsForDateRange(weeklyDb(false), '2026-09-07', '2026-09-13');
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].days[0].lunch_content, '');
  assert.equal(weeks[0].days[0].nightly_content, 'Dinner');
  assert.equal(weeks[0].week_start_date, '2026-09-07');
});
