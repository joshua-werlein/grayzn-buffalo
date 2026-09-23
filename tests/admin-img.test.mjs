import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const route = loadTs('src/pages/admin/img/[...key].ts');

const SESSION_TOKEN = 'a'.repeat(32); // valid 32-hex-char token shape

function makeCookies(authed = true) {
  return {
    get(name) {
      if (name === 'gb_session') return authed ? { value: SESSION_TOKEN } : null;
      return null;
    },
  };
}

function makeEnv({ hasPhotos = true, photoObjects = new Map(), hasSession = true } = {}) {
  return {
    SESSIONS: hasSession ? { get: async (key) => key === 'session:' + SESSION_TOKEN ? '1' : null } : null,
    PHOTOS: !hasPhotos ? undefined : {
      get: async (key) => {
        const obj = photoObjects.get(key);
        if (!obj) return null;
        return { arrayBuffer: async () => obj.data, httpMetadata: { contentType: obj.contentType } };
      },
    },
  };
}

function makeLocals(env) {
  return { runtime: { env } };
}

const TEST_IMAGE_KEY = 'special-imports/post1-abcdef1234567890abcd.jpg';
const TEST_IMAGE_DATA = new Uint8Array([0xff, 0xd8, 0xff]).buffer;

test('unauthenticated request returns 401', async () => {
  const env = makeEnv();
  const res = await route.GET({
    params: { key: TEST_IMAGE_KEY },
    locals: makeLocals(env),
    cookies: makeCookies(false),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('request with no session cookie returns 401', async () => {
  const env = makeEnv({ hasSession: false });
  const res = await route.GET({
    params: { key: TEST_IMAGE_KEY },
    locals: makeLocals(env),
    cookies: makeCookies(false),
  });
  assert.equal(res.status, 401);
});

test('authenticated request for non-special-imports/ key returns 404', async () => {
  const env = makeEnv();
  for (const key of ['facebook/post1-abc.jpg', 'menu/123/file.webp', 'welcome/abc.webp', '../secret']) {
    const res = await route.GET({
      params: { key },
      locals: makeLocals(env),
      cookies: makeCookies(true),
    });
    assert.equal(res.status, 404, `Expected 404 for key: ${key}`);
  }
});

test('path traversal attempt (../ in key) returns 404', async () => {
  const env = makeEnv();
  const res = await route.GET({
    params: { key: 'special-imports/../facebook/secret.jpg' },
    locals: makeLocals(env),
    cookies: makeCookies(true),
  });
  assert.equal(res.status, 404);
});

test('authenticated request with PHOTOS not configured returns 503', async () => {
  const env = makeEnv({ hasPhotos: false });
  const res = await route.GET({
    params: { key: TEST_IMAGE_KEY },
    locals: makeLocals(env),
    cookies: makeCookies(true),
  });
  assert.equal(res.status, 503);
});

test('authenticated request for missing R2 object returns 404', async () => {
  const env = makeEnv({ photoObjects: new Map() });
  const res = await route.GET({
    params: { key: TEST_IMAGE_KEY },
    locals: makeLocals(env),
    cookies: makeCookies(true),
  });
  assert.equal(res.status, 404);
});

test('authenticated request for existing R2 object returns 200 with image body', async () => {
  const objects = new Map([[TEST_IMAGE_KEY, { data: TEST_IMAGE_DATA, contentType: 'image/jpeg' }]]);
  const env = makeEnv({ photoObjects: objects });
  const res = await route.GET({
    params: { key: TEST_IMAGE_KEY },
    locals: makeLocals(env),
    cookies: makeCookies(true),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.ok(res.headers.get('cache-control')?.includes('private'));
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  const body = await res.arrayBuffer();
  assert.deepEqual(new Uint8Array(body), new Uint8Array(TEST_IMAGE_DATA));
});

test('content-type derived from file extension for common image formats', async () => {
  for (const [ext, expected] of [['jpg','image/jpeg'],['png','image/png'],['webp','image/webp'],['gif','image/gif']]) {
    const key = `special-imports/test-abc.${ext}`;
    const objects = new Map([[key, { data: new ArrayBuffer(1), contentType: 'image/octet-stream' }]]);
    const env = makeEnv({ photoObjects: objects });
    const res = await route.GET({
      params: { key },
      locals: makeLocals(env),
      cookies: makeCookies(true),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), expected, `ext=${ext}`);
  }
});
