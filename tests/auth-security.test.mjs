// Build first: exercise the compiled login route as well as auth/KV behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { loadTs } from './load-ts.mjs';
import { createOriginCheckMiddleware } from '../node_modules/astro/dist/core/app/middlewares.js';

const { login, logout, isAuthed, verifyTurnstile } = loadTs('src/lib/auth.ts');
const { onRequest } = loadTs('src/middleware.ts');
const admin = (await import('../dist/_worker.js/pages/admin.astro.mjs')).page().default;
const container = await AstroContainer.create();
const origin = 'https://grayznbuffalo.com';

function setup() {
  const values = new Map(), calls = [], jar = new Map();
  const env = {
    ADMIN_PASSWORD: 'test-password', TURNSTILE_SITEKEY: 'test-sitekey', TURNSTILE_SECRET: 'test-secret',
    SESSIONS: {
      get: async key => values.get(key) ?? null,
      put: async (key, value, options) => { calls.push({ key, options }); values.set(key, value); },
      delete: async key => values.delete(key),
    },
  };
  const cookies = {
    get: key => jar.has(key) ? { value: jar.get(key).value } : undefined,
    set: (key, value, options) => jar.set(key, { value, options }),
    delete: key => jar.delete(key),
  };
  return { env, cookies, jar, values, calls };
}
const post = (env, fields, cookie) => container.renderToResponse(admin, {
  request: new Request(origin + '/admin', {
    method: 'POST', headers: { origin, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields),
  }), locals: { runtime: { env } },
});

test('session cookies have secure flags and a matching 24-hour server expiry; logout revokes access', async () => {
  const f = setup();
  assert.equal(await login('wrong', f.cookies, f.env), false);
  assert.equal(f.calls.length, 0);
  assert.equal(await login('test-password', f.cookies, f.env), true);
  const { value, options } = f.jar.get('gb_session');
  assert.match(value, /^[0-9a-f]{32}$/);
  assert.deepEqual(options, { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 86400 });
  assert.equal(f.calls[0].options.expirationTtl, 86400);
  assert.equal(await isAuthed(f.cookies, f.env), true);
  await logout(f.cookies, f.env);
  assert.equal(f.values.size, 0);
  assert.equal(await isAuthed({ get: () => ({ value }) }, f.env), false);
});

test('malformed and expired sessions cannot authorize', async () => {
  const f = setup();
  for (const value of ['', 'bad-token', 'a'.repeat(32)]) {
    assert.equal(await isAuthed({ get: () => ({ value }) }, f.env), false);
  }
  assert.equal(await isAuthed(f.cookies, {}), false);
});

test('Turnstile fails closed for missing config/token and provider failures', async t => {
  const f = setup();
  const mocked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network'); });
  assert.equal(await verifyTurnstile('token', {}), false);
  assert.equal(await verifyTurnstile('', f.env), false);
  assert.equal(mocked.mock.callCount(), 0);
  for (const response of [null, new Response('invalid JSON'), Response.json({ success: false }),
    Response.json({ success: 'true' }), Response.json({ success: true }, { status: 500 })]) {
    mocked.mock.mockImplementation(async () => { if (!response) throw new Error('network'); return response; });
    assert.equal(await verifyTurnstile('token', f.env), false);
  }
});

test('compiled login never issues sessions when either Turnstile setting is missing', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  for (const key of ['TURNSTILE_SITEKEY', 'TURNSTILE_SECRET']) {
    const f = setup(); delete f.env[key];
    const response = await post(f.env, { action: 'login', password: 'test-password' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.has('set-cookie'), false);
    assert.equal(f.calls.length, 0);
    assert.match(await response.text(), /Staff sign-in is temporarily unavailable/);
  }
});

test('compiled login rejects invalid verification/password and accepts verified credentials', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => Response.json({ success: false }));
  for (const [human, password, expected] of [[false, 'test-password', 200], [true, 'wrong', 200], [true, 'test-password', 303]]) {
    const f = setup();
    mocked.mock.mockImplementation(async () => Response.json({ success: human }));
    const response = await post(f.env, { action: 'login', password, 'cf-turnstile-response': 'test-token' });
    assert.equal(response.status, expected);
    assert.equal(f.calls.length, expected === 303 ? 1 : 0);
    if (expected === 303) {
      assert.equal(response.headers.get('location'), '/admin/specials');
    }
  }
});

test('compiled logout revokes the stored session; unauthenticated settings actions never write D1', async () => {
  const f = setup();
  await login('test-password', f.cookies, f.env);
  const value = f.jar.get('gb_session').value;
  const response = await post(f.env, { action: 'logout' }, 'gb_session=' + value);
  assert.equal(response.status, 303);
  assert.equal(f.values.size, 0);
  f.env.DB = { prepare() { throw new Error('Unauthenticated D1 access'); } };
  for (const action of ['save-announcements', 'save-delivery-status']) {
    assert.equal((await post(f.env, { action })).status, 200);
  }
});

test('photo mutations reject unauthenticated/expired sessions before touching data', async () => {
  for (const path of ['menu-photo', 'welcome-photo']) {
    const { POST } = loadTs('src/pages/api/' + path + '.ts');
    for (const token of [undefined, 'a'.repeat(32)]) {
      const response = await POST({ request: new Request(origin + '/api/' + path, { method: 'POST' }),
        cookies: { get: () => token ? { value: token } : undefined },
        locals: { runtime: { env: { SESSIONS: { get: async () => null }, DB: { prepare() { throw new Error('Unexpected write'); } } } } },
      });
      assert.equal(response.status, 401);
    }
  }
});

test('all staff pages and photo API responses are no-store, including errors', async () => {
  for (const path of ['/admin', '/admin/menu', '/api/menu-photo', '/api/welcome-photo']) {
    for (const status of [200, 401, 503]) {
      const response = await onRequest({ url: new URL(origin + path) }, async () =>
        new Response('{}', { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } }));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    }
  }
});

test('Astro origin protection rejects cross-origin or missing-origin staff form submissions', async () => {
  const protect = createOriginCheckMiddleware();
  for (const path of ['/admin', '/admin/menu', '/admin/specials', '/api/menu-photo', '/api/welcome-photo']) {
    for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']) {
      for (const requestOrigin of [null, 'https://other.example', origin]) {
        const headers = { 'content-type': contentType };
        if (requestOrigin) headers.origin = requestOrigin;
        const url = new URL(origin + path);
        const response = await protect({ url, request: new Request(url, { method: 'POST', headers }) },
          async () => new Response('allowed'));
        assert.equal(response.status, requestOrigin === origin ? 200 : 403);
      }
    }
  }
});

test('compiled staff pages reject unauthenticated and expired sessions before loading data', async () => {
  for (const name of ['menu', 'specials', 'welcome-photos', 'analytics']) {
    const page = (await import('../dist/_worker.js/pages/admin/' + name + '.astro.mjs')).page().default;
    for (const method of ['GET', 'POST']) {
      const response = await container.renderToResponse(page, {
        request: new Request(origin + '/admin/' + name, {
          method, headers: { origin, cookie: 'gb_session=' + 'a'.repeat(32) },
        }), locals: { runtime: { env: {
          SESSIONS: { get: async () => null }, DB: { prepare() { throw new Error('Unauthorized DB access'); } },
        } } },
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/admin');
    }
  }
});
