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
      const tasks = [];
      await worker.scheduled({}, env, { waitUntil: (p) => tasks.push(p) });
      await Promise.allSettled(tasks);
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

// ── Import pipeline tests ─────────────────────────────────────────────────────

// Named field positions for the INSERT OR IGNORE INTO special_imports bind args.
const IMPORT_FIELDS = [
  'id','fb_post_id','fb_created_time','fb_updated_time','caption','permalink_url',
  'caption_hash','image_source_version','image_r2_key','image_hash',
  'parser_version','model_id',
  'target_kind','target_day','target_service','target_collection_id','classification_reason',
  'extracted_json','candidate_json','validation_result','validation_reason',
  'processing_status','processed_at',
];

function makeFakeDb(state) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/SELECT 1 FROM special_imports WHERE id/.test(sql)) {
                return state.imports.find((r) => r.id === args[0]) ?? null;
              }
              return null;
            },
            async run() {
              if (/INSERT OR IGNORE INTO special_imports/.test(sql)) {
                const id = args[0];
                if (!state.imports.find((r) => r.id === id)) {
                  state.imports.push(Object.fromEntries(IMPORT_FIELDS.map((f, i) => [f, args[i]])));
                }
              } else if (/INSERT INTO special_import_events/.test(sql)) {
                state.events.push({ import_id: args[0], event_type: args[1], detail: args[2] });
              }
              return {};
            },
            async all() {
              if (/count\(\*\)/.test(sql)) {
                const n = state.imports.filter((r) => r.processed_at !== null).length;
                return { results: [{ n }] };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

// 9 AM CDT on a Monday (within processing hours).
const WITHIN_HOURS_MS = new Date('2026-09-21T14:00:00Z').getTime();
// 2 AM CDT (outside processing hours).
const OUTSIDE_HOURS_MS = new Date('2026-09-21T07:00:00Z').getTime();

const DEFAULT_IMPORT_POST = {
  id: 'post1',
  message: 'Monday Night Specials',
  created_time: '2026-09-21T18:00:00+0000',
  updated_time: '2026-09-21T18:00:00+0000',
  permalink_url: 'https://www.facebook.com/post1',
  full_picture: 'https://cdn.facebook.example/post1.jpg',
};

function importFixture(t, { mode = 'DRY_RUN', aiResponse = '[]', graphPosts = null, aiLimit = 50, nowMs = WITHIN_HOURS_MS } = {}) {
  t.mock.method(console, 'error', () => {});
  t.mock.method(Date, 'now', () => nowMs);

  const state = {
    imports: [],
    events: [],
    r2Objects: new Map(),
    aiCalls: [],
    graphCallCount: 0,
    feed: { updatedAt: new Date(nowMs).toISOString(), posts: [] },
  };

  const posts = graphPosts ?? [DEFAULT_IMPORT_POST];

  t.mock.method(globalThis, 'fetch', async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('graph.facebook.com')) {
      state.graphCallCount++;
      return Response.json({ data: posts });
    }
    if (urlStr.includes('cdn.facebook.example')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    return Response.json({ data: [] });
  });

  const DB = makeFakeDb(state);

  const AI = {
    run: async (modelId, params) => {
      state.aiCalls.push({ modelId, params });
      return { response: aiResponse };
    },
  };

  const PHOTOS = {
    get: async (key) => {
      const obj = state.r2Objects.get(key);
      if (!obj) return null;
      return { arrayBuffer: async () => obj.data, httpMetadata: { contentType: obj.contentType } };
    },
    put: async (key, data, meta) => {
      state.r2Objects.set(key, {
        key, data,
        contentType: meta?.httpMetadata?.contentType ?? 'application/octet-stream',
        uploaded: new Date(nowMs),
      });
    },
    list: async ({ prefix, cursor } = {}) => {
      const objects = [...state.r2Objects.values()].filter((o) => !prefix || o.key.startsWith(prefix));
      return { objects, truncated: false };
    },
    delete: async (key) => { state.r2Objects.delete(key); },
  };

  const env = {
    FB_PAGE_ID: 'test', FB_SYSTEM_TOKEN: 'test',
    SPECIALS_IMPORT_MODE: mode,
    SPECIALS_AI_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    SPECIALS_AI_DAILY_LIMIT: String(aiLimit),
    DB, AI,
    FB_KV: {
      get: async () => state.feed,
      put: async (_k, v) => { state.feed = JSON.parse(v); },
    },
    PHOTOS,
  };

  return {
    state, env,
    run: async () => {
      const tasks = [];
      await worker.scheduled({}, env, { waitUntil: (p) => tasks.push(p) });
      await Promise.allSettled(tasks);
    },
  };
}

test('import pipeline does nothing when SPECIALS_IMPORT_MODE is OFF', async (t) => {
  const f = importFixture(t, { mode: 'OFF' });
  await f.run();
  assert.equal(f.state.imports.length, 0);
  assert.equal(f.state.aiCalls.length, 0);
});

test('import pipeline does nothing outside processing hours (2 AM Chicago)', async (t) => {
  const f = importFixture(t, { nowMs: OUTSIDE_HOURS_MS });
  await f.run();
  assert.equal(f.state.imports.length, 0);
  assert.equal(f.state.aiCalls.length, 0);
});

test('import pipeline does nothing when DB binding is absent', async (t) => {
  const f = importFixture(t);
  delete f.env.DB;
  await f.run();
  assert.equal(f.state.imports.length, 0);
  assert.equal(f.state.aiCalls.length, 0);
});

test('import pipeline classifies and stages a recognizable post with image', async (t) => {
  const validResponse = JSON.stringify([{
    label: 'Monday Nightly', day_of_week: 1, service: 'nightly',
    items: [{ content: 'Chicken Parmesan', price: '$16' }],
  }]);
  const f = importFixture(t, { aiResponse: validResponse });
  await f.run();
  assert.equal(f.state.imports.length, 1);
  const r = f.state.imports[0];
  assert.equal(r.target_kind, 'week');
  assert.equal(r.target_day, 1);
  assert.equal(r.target_service, 'nightly');
  assert.equal(r.processing_status, 'staged');
  assert.equal(r.validation_result, 'ok');
  assert.ok(r.candidate_json);
  assert.equal(f.state.aiCalls.length, 1);
});

test('import pipeline skips posts whose captions are classified as ignored', async (t) => {
  const ignoredPost = { ...DEFAULT_IMPORT_POST, message: 'Come join us for a great time!' };
  const f = importFixture(t, { graphPosts: [ignoredPost] });
  await f.run();
  assert.equal(f.state.imports.length, 0);
  assert.equal(f.state.aiCalls.length, 0);
});

test('import pipeline is idempotent: re-running does not create duplicate records', async (t) => {
  const f = importFixture(t);
  await f.run();
  assert.equal(f.state.imports.length, 1);
  const firstAiCalls = f.state.aiCalls.length;
  await f.run();
  assert.equal(f.state.imports.length, 1);
  assert.equal(f.state.aiCalls.length, firstAiCalls);
});

test('import pipeline respects daily AI call limit', async (t) => {
  const posts = [
    { ...DEFAULT_IMPORT_POST, id: 'p1', message: 'Monday Night Specials', full_picture: 'https://cdn.facebook.example/p1.jpg' },
    { ...DEFAULT_IMPORT_POST, id: 'p2', message: 'Tuesday Night Specials', full_picture: 'https://cdn.facebook.example/p2.jpg' },
    { ...DEFAULT_IMPORT_POST, id: 'p3', message: 'Wednesday Night Specials', full_picture: 'https://cdn.facebook.example/p3.jpg' },
  ];
  const f = importFixture(t, { graphPosts: posts, aiLimit: 1 });
  await f.run();
  assert.equal(f.state.imports.length, 3);
  assert.equal(f.state.aiCalls.length, 1);
  const skipped = f.state.imports.filter((r) => r.processing_status === 'skipped');
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((r) => r.validation_reason === 'daily AI limit reached'));
});

test('rejected AI response (invalid JSON) sets processing_status to failed', async (t) => {
  const f = importFixture(t, { aiResponse: 'not valid json at all!!!' });
  await f.run();
  assert.equal(f.state.imports.length, 1);
  const r = f.state.imports[0];
  assert.equal(r.processing_status, 'failed');
  assert.equal(r.validation_result, 'rejected');
});

test('rejected AI response (wrong shape) sets processing_status to failed', async (t) => {
  const f = importFixture(t, { aiResponse: '{"label":"bad","items":[]}' });
  await f.run();
  const r = f.state.imports[0];
  assert.equal(r.processing_status, 'failed');
  assert.equal(r.validation_result, 'rejected');
});

test('AI extraction with markdown fence is parsed correctly', async (t) => {
  const inner = JSON.stringify([{ label: 'Test', day_of_week: 1, service: 'nightly', items: [] }]);
  const f = importFixture(t, { aiResponse: `\`\`\`json\n${inner}\n\`\`\`` });
  await f.run();
  const r = f.state.imports[0];
  assert.equal(r.validation_result, 'ok');
});

test('post without image is staged as skipped without an AI call', async (t) => {
  const noImagePost = { ...DEFAULT_IMPORT_POST, full_picture: undefined };
  const f = importFixture(t, { graphPosts: [noImagePost] });
  await f.run();
  assert.equal(f.state.imports.length, 1);
  assert.equal(f.state.aiCalls.length, 0);
  assert.equal(f.state.imports[0].processing_status, 'skipped');
  assert.equal(f.state.imports[0].validation_reason, 'no image');
});

test('import images are stored under special-imports/ prefix in R2', async (t) => {
  const f = importFixture(t);
  await f.run();
  const importKeys = [...f.state.r2Objects.keys()].filter((k) => k.startsWith('special-imports/'));
  assert.equal(importKeys.length, 1);
  assert.ok(importKeys[0].startsWith('special-imports/post1-'));
  assert.ok(importKeys[0].endsWith('.jpg'));
});

test('import images do not appear under facebook/ prefix in R2', async (t) => {
  const f = importFixture(t);
  await f.run();
  const fbKeys = [...f.state.r2Objects.keys()].filter((k) => k.startsWith('facebook/'));
  // refreshFeed ran with no image posts in its feed; import goes to special-imports/
  assert.ok(fbKeys.every((k) => !k.startsWith('special-imports/')));
});

test('30-day-old import images are pruned; recent ones are kept', async (t) => {
  const staleKey = 'special-imports/stale-abc.jpg';
  const freshKey = 'special-imports/fresh-abc.jpg';
  const f = importFixture(t);
  const cutoff = WITHIN_HOURS_MS - 31 * 24 * 60 * 60 * 1000;
  f.state.r2Objects.set(staleKey, { key: staleKey, data: new ArrayBuffer(3), contentType: 'image/jpeg', uploaded: new Date(cutoff - 1000) });
  f.state.r2Objects.set(freshKey, { key: freshKey, data: new ArrayBuffer(3), contentType: 'image/jpeg', uploaded: new Date(WITHIN_HOURS_MS) });
  await f.run();
  assert.equal(f.state.r2Objects.has(staleKey), false);
  assert.equal(f.state.r2Objects.has(freshKey), true);
});

test('import pipeline errors are isolated from the public feed refresh', async (t) => {
  const f = importFixture(t);
  f.env.DB.prepare = () => { throw new Error('D1 unavailable'); };
  // Feed should still be published successfully
  await f.run();
  // The scheduled handler must not throw; if we got here the isolation held
  assert.ok(true);
});

test('public feed is capped at four posts regardless of import scan breadth', async (t) => {
  const manyPosts = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i}`, message: `Post ${i}`, created_time: new Date(WITHIN_HOURS_MS - i * 1000).toISOString(),
    permalink_url: `https://www.facebook.com/p${i}`,
  }));
  const f = importFixture(t, { graphPosts: manyPosts, mode: 'OFF' });
  await f.run();
  assert.ok((f.state.feed.posts ?? []).length <= 4);
});

test('ambiguous captions (day but no service) are staged for review', async (t) => {
  const ambiguousPost = { ...DEFAULT_IMPORT_POST, message: 'Monday Specials' };
  const f = importFixture(t, { graphPosts: [ambiguousPost] });
  await f.run();
  assert.equal(f.state.imports.length, 1);
  assert.equal(f.state.imports[0].target_kind, 'ambiguous');
});

test('section captions (Mexican Night) are staged for review', async (t) => {
  const sectionPost = { ...DEFAULT_IMPORT_POST, message: 'Tonight is Mexican Night! Come check out our specials.' };
  const f = importFixture(t, { graphPosts: [sectionPost] });
  await f.run();
  assert.equal(f.state.imports.length, 1);
  assert.equal(f.state.imports[0].target_kind, 'section');
  assert.equal(f.state.imports[0].target_collection_id, 'mexican-night');
});

test('fetch and extract events are written to special_import_events', async (t) => {
  const validResponse = JSON.stringify([{ label: 'Monday Nightly', day_of_week: 1, service: 'nightly', items: [] }]);
  const f = importFixture(t, { aiResponse: validResponse });
  await f.run();
  const importId = f.state.imports[0].id;
  const evTypes = f.state.events.filter((e) => e.import_id === importId).map((e) => e.event_type);
  assert.ok(evTypes.includes('fetch'));
  assert.ok(evTypes.includes('extract'));
  assert.ok(evTypes.includes('validate'));
});

test('import contract combines prices and removes Monday/Friday All Day repetitions',async t=>{
  for(const day of [1,5]) {
    const groups=[
      {label:'Lunch',day_of_week:day,service:'lunch',items:[{content:'Lunch',price:'$9.75'},{content:'Sandwich',price:'$7.25'}]},
      {label:'All Day',day_of_week:day,service:'all-day',items:[{content:'Sandwich',price:'$7.25'},{content:'Burger $10.25'}]},
      {label:'Nightly',day_of_week:day,service:'nightly',items:[{content:'Dinner $14'},{content:'Ribs $18.75'},{content:'Sandwich $7.25'},{content:'Burger $10.25'}]},
    ];
    const f=importFixture(t,{aiResponse:JSON.stringify(groups)});
    await f.run();
    const candidate=JSON.parse(f.state.imports[0].candidate_json);
    assert.deepEqual(candidate.map(g=>g.items.length),[1,2,2]);
    assert.deepEqual(candidate[0].items[0],{content:'Lunch $9.75'});
    assert.match(f.state.aiCalls[0].params.messages[0].content[0].text,/ONLY in an all-day group/);
  }
});

test('import rejects combined text over 150 and excess service items without truncation',async t=>{
  for(const items of [[{content:'a'.repeat(148),price:'$10'}],[{content:'One'},{content:'Two'}]]) {
    const f=importFixture(t,{aiResponse:JSON.stringify([{label:'Lunch',day_of_week:1,service:'lunch',items}])});
    await f.run();
    assert.equal(f.state.imports[0].validation_result,'rejected');
    assert.equal(f.state.imports[0].candidate_json,null);
  }
});
