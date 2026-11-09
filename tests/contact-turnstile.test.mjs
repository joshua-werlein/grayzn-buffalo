import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { POST } = loadTs('src/pages/api/contact.ts');
const env = { TURNSTILE_SECRET: 'mock-secret', RESEND_API_KEY: 'mock-key', CONTACT_TO_EMAIL: 'staff@example.com' };
const body = { name: 'Local test', email: 'visitor@example.com', message: 'Mocked only', 'cf-turnstile-response': 'mock-token' };
const submit = (fields = body, locals = { runtime: { env } }) => POST({ locals,
  request: new Request('https://grayznbuffalo.com/api/contact', { method: 'POST', body: JSON.stringify(fields) }) });

test('contact rejects missing and oversized tokens before any provider request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('Unexpected provider call'); });
  for (const token of [undefined, '', ' ', 'x'.repeat(2049)]) {
    assert.equal((await submit({ ...body, 'cf-turnstile-response': token })).status, 400);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('invalid, expired, replayed and mismatched-secret results never reach Resend', async t => {
  for (const code of ['invalid-input-response', 'timeout-or-duplicate', 'invalid-input-secret']) {
    await t.test(code, async t => {
      const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
        assert.equal(options.body.get('secret'), env.TURNSTILE_SECRET);
        assert.equal(options.body.get('response'), body['cf-turnstile-response']);
        return Response.json({ success: false, 'error-codes': [code] });
      });
      assert.equal((await submit()).status, 400);
      assert.equal(fetch.mock.callCount(), 1);
    });
  }
});

test('every submission revalidates, so a redeemed token cannot send a second email', async t => {
  const calls = [];
  let redeemed = false;
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    if (url.endsWith('/siteverify')) {
      const success = !redeemed;
      redeemed = true;
      return Response.json({ success, 'error-codes': success ? [] : ['timeout-or-duplicate'] });
    }
    assert.equal(url, 'https://api.resend.com/emails');
    return Response.json({ id: 'mock-only' });
  });
  assert.equal((await submit()).status, 200);
  assert.equal((await submit()).status, 400);
  assert.deepEqual(calls, ['https://challenges.cloudflare.com/turnstile/v0/siteverify',
    'https://api.resend.com/emails', 'https://challenges.cloudflare.com/turnstile/v0/siteverify']);
});
