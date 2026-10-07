import assert from 'node:assert/strict';
import test from 'node:test';
import {createHmac} from 'node:crypto';
import worker from './worker.js';
import {harness} from './test-fixture.js';
import {WEBHOOK_DELAY_SECONDS, WEBHOOK_MAX_BYTES} from './webhook.js';

const PAGE_ID = '583672228384067';
const SECRET = 'test-app-secret';
const VERIFY = 'test-verify-token';
const URL_BASE = 'https://grayznbuffalo.com/api/facebook-webhook';

function webhookEnv(t, mode = 'LOG') {
  const sent = [], logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(JSON.stringify(args)));
  const env = {FB_PAGE_ID: PAGE_ID, FB_APP_SECRET: SECRET, FB_WEBHOOK_VERIFY_TOKEN: VERIFY, WEBHOOK_TRIGGER_MODE: mode,
    IMPORT_TRIGGER: {send: async (body, options) => { sent.push({body, options}); }}};
  return {env, sent, logs};
}
const feedEvent = (overrides = {}) => ({object: 'page', entry: [{id: PAGE_ID, time: 1, changes: [{field: 'feed',
  value: {item: 'photo', verb: 'add', post_id: `${PAGE_ID}_1`, message: 'Private poster caption', ...overrides}}]}]});
const sign = (body, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
function post(payload, {signature, raw} = {}) {
  const body = raw ?? JSON.stringify(payload);
  const headers = {'content-type': 'application/json'};
  if (signature !== null) headers['x-hub-signature-256'] = signature ?? sign(body);
  return new Request(URL_BASE, {method: 'POST', headers, body});
}
const call = (request, env) => worker.fetch(request, env, {waitUntil() {}});
const verifyUrl = (token, mode = 'subscribe') =>
  `${URL_BASE}?hub.mode=${mode}&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`;

test('GET verification echoes the challenge for the configured token in every trigger mode', async t => {
  for (const mode of ['OFF', 'LOG', 'RUN']) {
    const {env, logs} = webhookEnv(t, mode);
    const response = await call(new Request(verifyUrl(VERIFY)), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '1158201444');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(logs.every(line => !line.includes(VERIFY)), 'verify token is never logged');
  }
});

test('GET verification rejects a wrong token, wrong mode, or missing configured token', async t => {
  const {env, logs} = webhookEnv(t);
  assert.equal((await call(new Request(verifyUrl('wrong-token')), env)).status, 403);
  assert.equal((await call(new Request(verifyUrl(VERIFY, 'unsubscribe')), env)).status, 403);
  assert.equal((await call(new Request(verifyUrl('')), {...env, FB_WEBHOOK_VERIFY_TOKEN: ''})).status, 403);
  assert.equal((await call(new Request(verifyUrl(VERIFY)), {...env, FB_WEBHOOK_VERIFY_TOKEN: undefined})).status, 403);
  assert.ok(logs.every(line => !line.includes('wrong-token') && !line.includes(VERIFY)));
});

test('POST without a signature is rejected and never enqueued', async t => {
  const {env, sent} = webhookEnv(t, 'RUN');
  assert.equal((await call(post(feedEvent(), {signature: null}), env)).status, 401);
  assert.equal(sent.length, 0);
});

test('POST with an invalid or tampered signature is rejected and never enqueued', async t => {
  const {env, sent, logs} = webhookEnv(t, 'RUN');
  const body = JSON.stringify(feedEvent());
  for (const signature of [sign(body, 'wrong-secret'), sign(body + ' '), 'sha256=zz', 'sha1=' + 'a'.repeat(40), sign(body).toUpperCase().replace('SHA256', 'md5')]) {
    assert.equal((await call(post(null, {raw: body, signature}), env)).status, 401, signature);
  }
  assert.equal((await call(post(feedEvent()), {...env, FB_APP_SECRET: undefined})).status, 401, 'missing app secret fails closed');
  assert.equal(sent.length, 0);
  assert.ok(logs.every(line => !line.includes(SECRET) && !line.includes('Private poster caption')));
});

test('POST rejects oversized bodies before verification', async t => {
  const {env, sent} = webhookEnv(t, 'RUN');
  const raw = JSON.stringify({object: 'page', pad: 'x'.repeat(WEBHOOK_MAX_BYTES)});
  assert.equal((await call(post(null, {raw}), env)).status, 413);
  assert.equal(sent.length, 0);
});

test('signed JSON is parsed only after verification; malformed signed JSON is rejected', async t => {
  const {env, sent} = webhookEnv(t, 'RUN');
  assert.equal((await call(post(null, {raw: '{not json'}), env)).status, 400);
  assert.equal(sent.length, 0);
});

test('signed events for another Page, another object, or non-feed fields are ignored with 200', async t => {
  const {env, sent} = webhookEnv(t, 'RUN');
  const otherPage = feedEvent(); otherPage.entry[0].id = '999';
  const otherObject = {...feedEvent(), object: 'user'};
  const nonFeed = feedEvent(); nonFeed.entry[0].changes[0].field = 'ratings';
  const comment = feedEvent({item: 'comment'});
  const reaction = feedEvent({item: 'reaction'});
  for (const payload of [otherPage, otherObject, nonFeed, comment, reaction, {object: 'page'}]) {
    const response = await call(post(payload), env);
    assert.equal(response.status, 200);
  }
  assert.equal(sent.length, 0);
});

test('valid signed feed event in LOG mode is logged with safe metadata and not enqueued', async t => {
  const {env, sent, logs} = webhookEnv(t, 'LOG');
  const response = await call(post(feedEvent()), env);
  assert.equal(response.status, 200);
  assert.equal(sent.length, 0);
  const line = logs.find(entry => entry.includes('"result":"accepted"'));
  assert.ok(line, 'accepted event logged');
  assert.match(line, /"mode":"LOG"/); assert.match(line, /"pageMatch":true/);
  assert.match(line, /"feedChanges":1/); assert.match(line, /"queued":false/);
  assert.ok(logs.every(entry => !entry.includes('Private poster caption') && !entry.includes(SECRET) && !entry.includes('sha256=')));
});

test('valid signed feed event in OFF mode is accepted but not enqueued', async t => {
  const {env, sent} = webhookEnv(t, 'OFF');
  assert.equal((await call(post(feedEvent()), env)).status, 200);
  assert.equal((await call(post(feedEvent()), {...env, WEBHOOK_TRIGGER_MODE: undefined})).status, 200, 'unset mode behaves as OFF');
  assert.equal(sent.length, 0);
});

test('valid signed feed event in RUN mode enqueues one delayed content-free trigger', async t => {
  const {env, sent, logs} = webhookEnv(t, 'RUN');
  const payload = feedEvent();
  payload.entry[0].changes.push({field: 'feed', value: {item: 'status', verb: 'edited', post_id: `${PAGE_ID}_2`}});
  const response = await call(post(payload), env);
  assert.equal(response.status, 200);
  assert.equal(sent.length, 1, 'one trigger per delivery; the consumer rescans everything');
  assert.deepEqual(Object.keys(sent[0].body).sort(), ['receivedAt', 'type']);
  assert.equal(sent[0].body.type, 'facebook-feed-change');
  assert.deepEqual(sent[0].options, {delaySeconds: WEBHOOK_DELAY_SECONDS});
  assert.equal(WEBHOOK_DELAY_SECONDS, 60);
  assert.ok(logs.some(line => line.includes('"queued":true') && line.includes('"feedChanges":2')));
});

test('RUN mode enqueue failure returns 503 so Meta redelivers', async t => {
  const {env} = webhookEnv(t, 'RUN');
  env.IMPORT_TRIGGER.send = async () => { throw new Error('Queue unavailable'); };
  assert.equal((await call(post(feedEvent()), env)).status, 503);
  assert.equal((await call(post(feedEvent()), {...env, IMPORT_TRIGGER: undefined})).status, 503);
});

test('other methods on the webhook path are rejected; the feed endpoint stays GET-only', async t => {
  const {env} = webhookEnv(t);
  const put = await call(new Request(URL_BASE, {method: 'PUT', body: '{}'}), env);
  assert.equal(put.status, 405);
  assert.equal(put.headers.get('allow'), 'GET, POST');
  const feedPost = await call(new Request('https://grayznbuffalo.com/api/facebook-feed', {method: 'POST', body: '{}'}), env);
  assert.equal(feedPost.status, 405);
  assert.equal(feedPost.headers.get('allow'), 'GET');
});

// ── Queue consumer ─────────────────────────────────────────────────────────────

function queueHarness(t) {
  const f = harness(t);
  f.state.posts[0].permalink_url = 'https://www.facebook.com/p1';
  let feed = {updatedAt: new Date(f.state.now).toISOString(), posts: []};
  f.env.FB_KV = {get: async () => feed, put: async (_key, value) => { feed = JSON.parse(value); }};
  t.mock.method(console, 'log', () => {});
  const messages = n => ({messages: Array.from({length: n}, (_, i) => ({id: `m${i}`, body: {type: 'facebook-feed-change'}}))});
  return {f, feed: () => feed, messages};
}
const graphCalls = f => f.state.calls.filter(url => url.hostname === 'graph.facebook.com');

test('queue consumer runs the full feed refresh and complete current-day import once per batch', async t => {
  const {f, feed, messages} = queueHarness(t);
  await worker.queue(messages(3), f.env, {waitUntil() {}});
  const graph = graphCalls(f);
  assert.equal(graph.length, 2, 'one feed refresh and one complete-day scan for a three-message burst');
  assert.ok(graph.some(url => url.searchParams.get('limit') === '4' && !url.searchParams.has('since')), 'existing refreshFeed request');
  assert.ok(graph.some(url => url.searchParams.has('since') && url.searchParams.has('until')), 'existing complete current-day scan');
  assert.equal(f.state.aiCalls, 1);
  assert.equal(f.imports().length, 1);
  assert.equal(f.imports()[0].processing_status, 'staged');
  assert.equal(f.slots()[0].origin, 'automation', 'existing guarded reconciliation published');
  assert.equal(feed().posts.length, 1, 'public feed refreshed');
});

test('redelivered queue batches are harmless: no duplicate claims, AI calls or writes', async t => {
  const {f, messages} = queueHarness(t);
  await worker.queue(messages(1), f.env, {waitUntil() {}});
  const slots = JSON.stringify(f.slots());
  await worker.queue(messages(1), f.env, {waitUntil() {}});
  await Promise.all([worker.queue(messages(1), f.env, {waitUntil() {}}), worker.queue(messages(1), f.env, {waitUntil() {}})]);
  assert.equal(f.state.aiCalls, 1);
  assert.equal(f.imports().length, 1);
  assert.equal(JSON.stringify(f.slots()), slots);
});

test('queue consumer surfaces an import pipeline failure so the batch is retried', async t => {
  const {f, feed, messages} = queueHarness(t);
  t.mock.method(console, 'error', () => {});
  f.env.DB = {...f.env.DB, prepare: () => { throw new Error('D1 unavailable'); }};
  await assert.rejects(() => worker.queue(messages(2), f.env, {waitUntil() {}}), /D1 unavailable/);
  assert.equal(feed().posts.length, 1, 'the feed refresh still completed before the retry signal');
});

test('cron path is unchanged: both existing tasks run and import errors stay isolated', async t => {
  const {f} = queueHarness(t);
  const tasks = [];
  await worker.scheduled({}, f.env, {waitUntil: p => tasks.push(p)});
  assert.equal(tasks.length, 2);
  await Promise.all(tasks);
  assert.equal(graphCalls(f).length, 2);
  assert.equal(f.imports()[0].processing_status, 'staged');
  f.env.DB = {...f.env.DB, prepare: () => { throw new Error('D1 unavailable'); }};
  const failing = [];
  await worker.scheduled({}, f.env, {waitUntil: p => failing.push(p)});
  await assert.doesNotReject(() => Promise.all(failing));
});
