import {builtRoute} from './built-output.mjs';
// Build first: exercise the compiled login route as well as auth/KV behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { loadTs } from './load-ts.mjs';
import { adminCredentials } from './admin-session-fixture.mjs';
import { createOriginCheckMiddleware } from '../node_modules/astro/dist/core/app/origin-check.js';
import { getSetCookiesFromResponse } from '../node_modules/astro/dist/core/cookies/index.js';

const { login, logout, isAuthed, verifyTurnstile } = loadTs('src/lib/auth.ts');
const { onRequest } = loadTs('src/middleware.ts');
const admin = (await builtRoute('admin')).default;
const container = await AstroContainer.create();
const origin = 'https://grayznbuffalo.com';

function setup() {
  const values = new Map(), calls = [], jar = new Map();
  const env = {
    ...adminCredentials, TURNSTILE_SITEKEY: 'test-sitekey', TURNSTILE_SECRET: 'test-secret',
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
  const withToken = value => ({ get: () => ({ value }) });
  let kvReads = 0;
  const env = { ...f.env, SESSIONS: { get: async () => { kvReads++; return null; } } };
  for (const value of ['', 'bad-token', 'A'.repeat(32), 'a'.repeat(33)]) {
    assert.equal(await isAuthed(withToken(value), env), false);
  }
  assert.equal(kvReads, 0);
  await login(f.env.ADMIN_PASSWORD, f.cookies, f.env);
  const token = f.jar.get('gb_session').value;
  f.values.delete('session:' + token); // KV returns null after the configured TTL.
  assert.equal(await isAuthed(f.cookies, f.env), false);
  for (const stored of ['1', 'v1:bad', { invalid: true }]) {
    f.values.set('session:' + token, stored);
    assert.equal(await isAuthed(f.cookies, f.env), false);
  }
});

test('missing session configuration and KV failures deny access and never issue a cookie', async () => {
  const f = setup();
  assert.equal(await login(f.env.ADMIN_PASSWORD, f.cookies, f.env), true);
  const fresh = setup();
  const configOverrides = [
    { ADMIN_PASSWORD: undefined }, { ADMIN_PASSWORD: '' }, { ADMIN_SESSION_KEY: undefined },
    { ADMIN_SESSION_KEY: 'short' }, { SESSIONS: undefined },
    { SESSIONS: { get: async () => { throw new Error('KV read failed'); },
      put: async () => { throw new Error('KV write failed'); } } },
  ];
  for (const overrides of configOverrides) {
    const env = { ...f.env, ...overrides };
    assert.equal(await isAuthed(f.cookies, env), false);
    assert.equal(await login(f.env.ADMIN_PASSWORD, fresh.cookies, env), false);
    assert.equal(fresh.jar.size, 0);
  }
  assert.equal(f.calls.length, 1);
});

test('password rotation rejects old sessions and accepts a fresh login with the new password', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true }));
  const f = setup();
  const signIn = (env, password) => post(env, { action: 'login', password, 'cf-turnstile-response': 'test-token' });
  const sessionCookie = async (env, password) => {
    const response = await signIn(env, password);
    assert.equal(response.status, 303);
    const cookie = [...getSetCookiesFromResponse(response)].find(value => value.startsWith('gb_session='));
    assert.ok(cookie);
    return cookie.split(';')[0];
  };
  const getAdmin = (env, cookie) => container.renderToResponse(admin, {
    request: new Request(origin + '/admin', { headers: { cookie } }), locals: { runtime: { env } },
  });
  const oldCookie = await sessionCookie(f.env, f.env.ADMIN_PASSWORD);
  const redeployed = { ...f.env, SESSIONS: { ...f.env.SESSIONS } };
  assert.equal((await getAdmin(redeployed, oldCookie)).headers.get('location'), '/admin/specials');

  const rotated = { ...redeployed, ADMIN_PASSWORD: 'new-test-password' };
  const denied = await getAdmin(rotated, oldCookie);
  assert.equal(denied.status, 200);
  assert.match(await denied.text(), /Staff Sign In/);
  assert.deepEqual([...getSetCookiesFromResponse(await signIn(rotated, f.env.ADMIN_PASSWORD))], []);
  const newCookie = await sessionCookie(rotated, rotated.ADMIN_PASSWORD);
  assert.notEqual(newCookie, oldCookie);
  assert.equal((await getAdmin(rotated, newCookie)).headers.get('location'), '/admin/specials');
  assert.equal((await getAdmin(rotated, oldCookie)).status, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(f.values.size, 2); // The previous record may still be served from KV.
});

test('a session signature cannot be copied to a different token', async () => {
  const f = setup();
  await login(f.env.ADMIN_PASSWORD, f.cookies, f.env);
  const [signature] = f.values.values();
  assert.match(signature, /^v1:[0-9a-f]{64}$/);
  const token = 'a'.repeat(32);
  f.values.set('session:' + token, signature);
  assert.equal(await isAuthed({ get: () => ({ value: token }) }, f.env), false);
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

test('photo mutations reject unauthenticated, expired and previous-password sessions before touching data', async () => {
  const f = setup();
  await login(f.env.ADMIN_PASSWORD, f.cookies, f.env);
  const staleToken = f.jar.get('gb_session').value;
  let storageAccesses = 0;
  const recordAccess = () => { storageAccesses++; throw new Error('Unauthorized storage access'); };
  const env = { ...f.env, ADMIN_PASSWORD: 'new-test-password', DB: { prepare: recordAccess },
    PHOTOS: { put: recordAccess, delete: recordAccess } };
  for (const path of ['menu-photo', 'welcome-photo']) {
    const { POST } = loadTs('src/pages/api/' + path + '.ts');
    for (const token of [undefined, 'a'.repeat(32), staleToken]) {
      const response = await POST({ request: new Request(origin + '/api/' + path, { method: 'POST' }),
        cookies: { get: () => token ? { value: token } : undefined },
        locals: { runtime: { env } },
      });
      assert.equal(response.status, 401);
    }
  }
  assert.equal(storageAccesses, 0);
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
        const context = { url, request: new Request(url, { method: 'POST', headers }) };
        const response = await protect(context, () => onRequest(context, async () => new Response('allowed')));
        assert.equal(response.status, requestOrigin === origin ? 200 : 403);
      }
    }
  }
});

test('compiled staff pages reject anonymous, expired and previous-password sessions before loading data', async () => {
  const f = setup();
  await login(f.env.ADMIN_PASSWORD, f.cookies, f.env);
  const env = { ...f.env, ADMIN_PASSWORD: 'new-test-password',
    DB: { prepare() { assert.fail('Unauthorized DB access'); } } };
  for (const name of ['menu', 'specials', 'welcome-photos', 'reviews', 'analytics']) {
    const page = (await builtRoute('admin/' + name)).default;
    for (const method of ['GET', 'POST']) {
      for (const token of [undefined, 'a'.repeat(32), f.jar.get('gb_session').value]) {
        const response = await container.renderToResponse(page, {
          request: new Request(origin + '/admin/' + name, {
            method, headers: { origin, ...(token ? { cookie: 'gb_session=' + token } : {}) },
          }), locals: { runtime: { env } },
        });
        assert.equal(response.status, 302);
        // Menu sends staff back to itself after sign-in and says an unsaved change was lost.
        const expected = {
          menu: method === 'POST' ? '/admin?next=/admin/menu&expired=1' : '/admin?next=/admin/menu',
          'welcome-photos': '/admin?next=/admin/welcome-photos',
          reviews: '/admin?next=/admin/reviews',
        }[name] ?? '/admin';
        assert.equal(response.headers.get('location'), expected);
      }
    }
  }
});
