import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { imageFormat, imageKey, imageSourceVersion, shouldRefreshImage } from './worker.js';

test('maps supported Facebook image content types to matching extensions', () => {
  assert.deepEqual(imageFormat('image/jpeg'), { extension: 'jpg', contentType: 'image/jpeg' });
  assert.deepEqual(imageFormat('image/png; charset=binary'), { extension: 'png', contentType: 'image/png' });
  assert.deepEqual(imageFormat('image/webp'), { extension: 'webp', contentType: 'image/webp' });
  assert.deepEqual(imageFormat('image/gif'), { extension: 'gif', contentType: 'image/gif' });
});

test('uses a conservative fallback for unknown or missing content types', () => {
  assert.deepEqual(imageFormat('image/avif'), { extension: 'bin', contentType: 'image/avif' });
  assert.deepEqual(imageFormat(null), { extension: 'bin', contentType: 'application/octet-stream' });
});

test('does not refresh an existing image when its source version is unchanged', () => {
  const post = {
    id: '123',
    full_picture: 'https://cdn.example.com/photos/123.jpg?temporary-token=second',
    updated_time: '2026-08-04T18:00:00+0000',
  };
  const previous = {
    imageKey: 'facebook/123-abc.jpg',
    imageSourceVersion: imageSourceVersion(post),
  };

  assert.equal(shouldRefreshImage(post, previous), false);
});

test('refreshes an existing image when Graph reports a changed source version', () => {
  const previous = {
    imageKey: 'facebook/123-abc.jpg',
    imageSourceVersion: 'updated:2026-08-04T18:00:00+0000',
  };
  const changedPost = {
    id: '123',
    full_picture: 'https://cdn.example.com/photos/123-replaced.png',
    updated_time: '2026-08-04T19:00:00+0000',
  };

  assert.equal(shouldRefreshImage(changedPost, previous), true);
  assert.equal(imageKey(changedPost.id, 'abcdef', 'png'), 'facebook/123-abcdef.png');
});

test('uses a normalized image URL only when updated_time is unavailable', () => {
  const base = { id: '123', full_picture: 'https://cdn.example.com/photos/123.jpg?first-token' };
  const sameImageDifferentQuery = { ...base, full_picture: 'https://cdn.example.com/photos/123.jpg?second-token' };
  const previous = { imageKey: 'facebook/123-abc.jpg', imageSourceVersion: imageSourceVersion(base) };

  assert.equal(imageSourceVersion(base), imageSourceVersion(sameImageDifferentQuery));
  assert.equal(shouldRefreshImage(sameImageDifferentQuery, previous), false);
});

// All fetch, KV, and R2 operations below are in-memory doubles.
function refreshFixture(t) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  const oldKey = 'facebook/old-version.jpg';
  const orphanKey = 'facebook/orphan-version.jpg';
  const state = {
    feed: { updatedAt: new Date(now).toISOString(), posts: [{ id: 'old', imageKey: oldKey, imageUrl: '/img/' + oldKey }] },
    graph: [{ id: 'new', message: 'New post', created_time: new Date(now).toISOString(), permalink_url: 'https://www.facebook.com/new' }],
    objects: new Map([oldKey, orphanKey].map((key) => [key, { key, uploaded: new Date(0) }])),
    calls: [], failPublish: false, failDelete: false, graphFailure: false,
  };
  t.mock.method(globalThis, 'fetch', async () => {
    if (state.graphFailure) throw new Error('Graph unavailable');
    return Response.json({ data: state.graph });
  });
  const env = {
    FB_PAGE_ID: 'test', FB_SYSTEM_TOKEN: 'test',
    FB_KV: {
      get: async () => structuredClone(state.feed),
      put: async (_key, value) => {
        state.calls.push('publish');
        if (state.failPublish) throw new Error('KV unavailable');
        state.feed = JSON.parse(value);
      },
    },
    PHOTOS: {
      list: async () => { state.calls.push('list'); return { objects: [...state.objects.values()], truncated: false }; },
      delete: async (key) => {
        state.calls.push('delete:' + key);
        if (state.failDelete) throw new Error('R2 unavailable');
        state.objects.delete(key);
      },
      put: async () => { throw new Error('Unexpected image upload'); },
    },
  };
  return {
    state, env, oldKey, orphanKey,
    advance: (ms) => { now += ms; },
    run: async () => {
      let task;
      await worker.scheduled({}, env, { waitUntil: (promise) => { task = promise; } });
      await task;
    },
  };
}

test('failed KV publication keeps the published feed and performs no pruning', async (t) => {
  const f = refreshFixture(t);
  f.state.failPublish = true;
  const before = structuredClone(f.state.feed);
  await f.run();
  assert.deepEqual(f.state.feed, before);
  assert.deepEqual(f.state.calls, ['publish']);
  assert.equal(f.state.objects.size, 2);
});

test('publishes before pruning and retains old feed images through the cache grace period', async (t) => {
  const f = refreshFixture(t);
  await f.run();
  assert.equal(f.state.calls[0], 'publish');
  assert.equal(f.state.objects.has(f.oldKey), true);
  assert.equal(f.state.objects.has(f.orphanKey), false);
  assert.equal(f.state.feed.retainedPosts[0].imageKey, f.oldKey);
  f.advance(4 * 24 * 60 * 60 * 1000);
  await f.run();
  assert.equal(f.state.objects.has(f.oldKey), true);
  f.advance(6 * 60 * 1000);
  await f.run();
  assert.equal(f.state.objects.has(f.oldKey), false);
});

test('retries a failed prune when the Facebook post list remains unchanged', async (t) => {
  const f = refreshFixture(t);
  f.state.failDelete = true;
  await f.run();
  assert.equal(f.state.feed.posts[0].id, 'new');
  assert.equal(f.state.objects.has(f.orphanKey), true);
  f.state.failDelete = false;
  f.state.calls.length = 0;
  await f.run();
  assert.deepEqual(f.state.calls, ['publish', 'list', 'delete:' + f.orphanKey]);
  assert.equal(f.state.objects.has(f.oldKey), true);
});

test('protects current post versions, legacy exact keys, and recent orphan uploads', async (t) => {
  const f = refreshFixture(t);
  const legacyKey = 'facebook/2026-09-01/old.jpg';
  f.state.feed.posts[0].imageKey = legacyKey;
  f.state.objects.set(legacyKey, { key: legacyKey, uploaded: new Date(0) });
  f.state.objects.set('facebook/new-previous.jpg', { key: 'facebook/new-previous.jpg', uploaded: new Date(0) });
  f.state.objects.set('facebook/recent.jpg', { key: 'facebook/recent.jpg', uploaded: new Date() });
  await f.run();
  assert.equal(f.state.objects.has(legacyKey), true);
  assert.equal(f.state.objects.has('facebook/new-previous.jpg'), true);
  assert.equal(f.state.objects.has('facebook/recent.jpg'), true);
});

test('Graph failure preserves the last good feed and media', async (t) => {
  const f = refreshFixture(t);
  f.state.graphFailure = true;
  const before = structuredClone(f.state.feed);
  await f.run();
  assert.deepEqual(f.state.feed, before);
  assert.deepEqual(f.state.calls, []);
  assert.equal(f.state.objects.size, 2);
});

test('the public endpoint still hides feeds older than four days and retention metadata', async (t) => {
  const f = refreshFixture(t);
  await f.run();
  const cache = { match: async () => undefined, put: async () => {} };
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: cache } });
  t.after(() => prior ? Object.defineProperty(globalThis, 'caches', prior) : delete globalThis.caches);
  const request = new Request('https://example.com/api/facebook-feed');
  const fresh = await (await worker.fetch(request, f.env, { waitUntil() {} })).json();
  assert.equal(fresh.posts.length, 1);
  assert.equal('retainedPosts' in fresh, false);
  f.state.feed.updatedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const stale = await (await worker.fetch(request, f.env, { waitUntil() {} })).json();
  assert.deepEqual(stale.posts, []);
});


test('retains a legacy image when its post remains live but Graph removes the image', async (t) => {
  const f = refreshFixture(t);
  const legacyKey = 'facebook/2026-09-01/old.jpg';
  f.state.feed.posts[0].imageKey = legacyKey;
  f.state.objects.set(legacyKey, { key: legacyKey, uploaded: new Date(0) });
  f.state.graph[0].id = 'old';
  await f.run();
  await f.run();
  assert.equal(f.state.objects.has(legacyKey), true);
  f.advance((4 * 24 * 60 * 60 + 6 * 60) * 1000);
  await f.run();
  assert.equal(f.state.objects.has(legacyKey), false);
});

test('malformed Graph JSON or a missing data array cannot replace the last good feed', async (t) => {
  for (const reply of [() => new Response('not json'), () => Response.json({ error: 'unexpected' })]) {
    const f = refreshFixture(t);
    t.mock.method(globalThis, 'fetch', async () => reply());
    const before = structuredClone(f.state.feed);
    await f.run();
    assert.deepEqual(f.state.feed, before);
    assert.deepEqual(f.state.calls, []);
  }
});
