import assert from 'node:assert/strict';
import test from 'node:test';
import {harness, offer, poster} from './test-fixture.js';
import worker from './worker.js';
import {isTransientFailure} from './recovery.js';

const TWO_MINUTES = 120_000;
const webhook = {body:{type:'facebook-feed-change'}};
const importRow = f => f.imports()[0];
const runQueue = (f, ...messages) => worker.queue({messages}, f.env);

async function runCron(f) {
  const tasks = [];
  await worker.scheduled({}, f.env, {waitUntil: task => tasks.push(task)});
  await Promise.all(tasks);
}

function mockTransientFailures(f, failures) {
  const succeed = f.env.AI.run;
  f.env.AI.run = async (...args) => {
    if (failures-- > 0) {
      f.state.aiCalls++;
      throw Object.assign(new Error('8005: Internal server error'), {name:'AiError'});
    }
    return succeed(...args);
  };
}

function setup(t, options) {
  const f = harness(t, options);
  const messages = [];
  f.env.FB_KV = {get:async () => null, put:async () => {}};
  f.env.IMPORT_TRIGGER = {send: async (body, options) => {
    const row = importRow(f);
    assert.equal(row.processing_status, 'pending', 'persisted before queue send');
    messages.push({body, delay:options.delaySeconds, deliverAt:f.state.now+options.delaySeconds*1000});
  }};
  return {...f, messages};
}

test('November 20 error becomes eligible 120 seconds after failure and publishes on queue delivery', async t => {
  const f = setup(t, {
    now:'2026-11-20T14:59:00Z', caption:'Friday Specials',
    candidate:{...poster(5,'Friday Specials',[offer('Burger $10','Burger $10','All Day')]), evidence_version:2},
  });
  Object.assign(f.env, {SPECIALS_EVIDENCE_VERSION:'2', SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  Object.assign(f.state.posts[0], {created_time:'2026-11-20T14:58:00Z', updated_time:'2026-11-20T14:58:00Z'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-16', week_end_date='2026-11-22' WHERE id=9000");
  mockTransientFailures(f, 1);
  const run = f.env.AI.run;
  f.env.AI.run = (...args) => {
    if (!f.state.aiCalls) f.state.now += 9_000;
    return run(...args);
  };
  await runQueue(f, webhook, webhook);
  const failureAt = f.state.now;
  const [retry] = f.messages;
  assert.equal(f.messages.length, 1);
  assert.equal(retry.delay, 120);
  assert.equal(importRow(f).failure_kind, 'transient_ai');
  assert.match(importRow(f).last_error, /AiError: 8005: Internal server error/);
  assert.equal(Date.parse(importRow(f).next_attempt_at), failureAt+TWO_MINUTES);
  assert.equal(retry.deliverAt, failureAt+TWO_MINUTES);

  f.state.now = retry.deliverAt-1;
  await runQueue(f, retry);
  await runQueue(f, retry, webhook);
  assert.equal(f.state.aiCalls, 1);
  assert.equal(importRow(f).retry_count, 1);
  const slotsForFriday = () => f.slots(5,'all-day');
  assert.ok(slotsForFriday().every(slot => slot.content===''));

  f.state.now = retry.deliverAt;
  await runQueue(f, retry);
  assert.equal(f.state.aiCalls, 2);
  assert.equal(importRow(f).retry_count, 2);
  assert.equal(importRow(f).processing_status, 'staged');
  assert.equal(importRow(f).next_attempt_at, null);
  assert.equal(slotsForFriday()[0].content, 'Burger $10');

  const calls = f.state.calls.length;
  const audit = f.sql('SELECT * FROM special_import_events ORDER BY id');
  const slots = slotsForFriday();
  await runQueue(f, retry, retry);
  assert.equal(f.state.calls.length, calls, 'completed retry delivery skips Graph and AI');
  assert.equal(f.state.aiCalls, 2);
  assert.deepEqual(f.sql('SELECT * FROM special_import_events ORDER BY id'), audit);
  assert.deepEqual(slotsForFriday(), slots);
});

test('November 23 Workers AI 499 retries the saved Monday image and publishes only the missing Nightly pair', async t => {
  const [lunch, turkey, ham, burgers, ribs] = [
    'GMAC Salad with a Drink $9.75',
    'Turkey Wrap with Side Salad, Chili or Coleslaw $10.25',
    'Grilled Ham & Cheese with Cup of Chili or Coleslaw $7.25',
    '2 Burgers with an Order of Fries $14',
    'Half Rack Ribs with Mac and Cheese and Coleslaw $18.75',
  ];
  const errors = new Error('InferenceUpstreamError: {"name":"AiError","internalCode":0,"httpCode":499,"message":"AiError: AiError: Client Closed Request (request-id)","description":"Client Closed Request"}');
  assert.equal(isTransientFailure(errors), false, 'image failures keep their existing classification');
  assert.equal(isTransientFailure(new Error('HTTP 499'), {workersAi:true}), false);
  const f = setup(t, {
    now:'2026-11-23T15:49:51Z', caption:'',
    candidate:poster(1,'GRAYZ\'N BUFFALO BAR & GRILL MONDAY SPECIALS',[
      offer(lunch, `1) ${lunch} (11-1:30)`, '11-1:30'), offer(turkey, `2) ${turkey}`), offer(ham, `3) ${ham}`),
    ]),
  });
  f.env.SPECIALS_EVIDENCE_VERSION = '2';
  f.env.SPECIALS_VERIFICATION_STRATEGY = 'conditional';
  const morning = f.state.posts[0];
  Object.assign(morning, {message:'',created_time:'2026-11-23T15:48:36Z',updated_time:'2026-11-23T15:48:36Z'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-23',week_end_date='2026-11-29' WHERE id=9000");
  await f.run();
  const contents = service => f.slots(1,service).map(s => s.content).filter(Boolean);
  assert.deepEqual(contents('all-day'), [turkey,ham]);
  assert.match(contents('lunch')[0], /Gmac Salad with a Drink \$9\.75/i);
  const morningSlots = [...f.slots(1,'lunch'), ...f.slots(1,'all-day')];

  f.state.posts.unshift({...morning,id:'p2',created_time:'2026-11-23T22:18:33Z',updated_time:'2026-11-23T22:18:33Z'});
  f.state.now = Date.parse('2026-11-23T22:20:12Z');
  f.state.candidate = poster(1,'MONDAY NIGHT SPECIALS',[burgers,ribs,turkey,ham].map(text => offer(text, text)));
  const succeed = f.env.AI.run;
  f.env.AI.run = async () => { throw errors; };
  // This fixture's first import is the morning post, so capture the retry directly.
  const messages = [];
  f.env.IMPORT_TRIGGER = {send:async (body, {delaySeconds}) => messages.push({body, delaySeconds})};
  await f.run();
  const nightlyImport = () => f.imports().find(row => row.fb_post_id==='p2');
  assert.equal(nightlyImport().failure_kind, 'transient_ai');
  assert.equal(nightlyImport().processing_status, 'pending');
  assert.ok(nightlyImport().image_r2_key);
  assert.deepEqual(contents('nightly'), []);
  const [retry] = messages;
  assert.equal(retry.delaySeconds, 120);
  const downloads = f.state.calls.filter(url => url.hostname==='cdn.example').length;

  f.env.AI.run = succeed;
  f.state.now += TWO_MINUTES;
  await runQueue(f, retry);
  assert.equal(nightlyImport().processing_status, 'staged');
  assert.equal(nightlyImport().retry_count, 2);
  assert.equal(f.state.calls.filter(url => url.hostname==='cdn.example').length, downloads);
  assert.deepEqual(contents('nightly'), [burgers,ribs]);
  assert.deepEqual([...f.slots(1,'lunch'), ...f.slots(1,'all-day')], morningSlots);
});

for (const failures of [2, 3]) {
  test(`queue recovery with ${failures} transient failures stops after the third import attempt`, async t => {
    const f = setup(t);
    mockTransientFailures(f, failures);
    await runQueue(f, webhook);

    for (let i=0; i<2; i++) {
      const retry = f.messages[i];
      assert.equal(retry.delay, 120);
      assert.equal(retry.deliverAt, f.state.now+TWO_MINUTES);
      f.state.now = retry.deliverAt;
      // Include redelivery of the first message when the second retry comes due.
      await runQueue(f, f.messages[0], retry);
    }

    assert.equal(f.messages.length, 2);
    assert.equal(importRow(f).retry_count, 3);
    assert.equal(importRow(f).next_attempt_at, null);
    assert.equal(importRow(f).processing_status, failures===2 ? 'staged' : 'failed');
    assert.equal(importRow(f).failure_kind, failures===2 ? null : 'exhausted');
    assert.equal(Boolean(f.slots()[0].content), failures===2);
    f.state.now += TWO_MINUTES;
    await Promise.all([runQueue(f, ...f.messages), runCron(f)]);
    assert.equal(f.messages.length, 2);
    assert.equal(f.state.aiCalls, 3);
  });
}

test('permanent AI errors, malformed responses and rejected evidence schedule no retry', async t => {
  const f = setup(t);
  for (const response of [
    Object.assign(new Error('8005: Internal server error'), {status:403}),
    'malformed JSON',
    JSON.stringify({day_of_week:4, day_evidence:'Thursday', offers:[]}),
  ]) {
    f.env.AI.run = async () => {
      if (response instanceof Error) throw response;
      return {response};
    };
    f.state.posts[0].id += '-new';
    await runQueue(f, webhook);
    const row = f.imports().at(-1);
    assert.equal(row.processing_status, 'failed');
    assert.equal(row.validation_result, 'rejected');
    assert.equal(row.next_attempt_at, null);
  }
  assert.equal(f.messages.length, 0);
});

test('an 8005 during an existing schema repair leaves the original rejection terminal', async t => {
  const f = setup(t);
  mockTransientFailures(f, 1);
  const fail = f.env.AI.run;
  f.env.AI.run = (...args) => {
    if (f.state.aiCalls) return fail(...args);
    f.state.aiCalls++;
    return {response:'malformed JSON'};
  };
  await runQueue(f, webhook);
  assert.equal(f.state.aiCalls, 2);
  assert.equal(importRow(f).validation_result, 'rejected');
  assert.equal(importRow(f).validation_reason, 'response is not valid JSON');
  assert.equal(f.messages.length, 0);
});

test('the 50-call budget counts the failure and blocks the queued attempt from invoking AI', async t => {
  const f = setup(t);
  mockTransientFailures(f, 1);
  await runQueue(f, webhook);
  const [retry] = f.messages;
  f.sql(`WITH RECURSIVE reservations(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM reservations WHERE n<49)
    INSERT INTO special_import_events(import_id,event_type,occurred_at) SELECT ?,'extract',? FROM reservations`,
    importRow(f).id, new Date(f.state.now).toISOString());
  f.state.now = retry.deliverAt;
  await runQueue(f, retry);
  assert.equal(f.state.aiCalls, 1);
  assert.equal(importRow(f).processing_status, 'skipped');
  assert.equal(importRow(f).failure_kind, 'budget');
  assert.equal(f.messages.length, 1);
});

for (const failure of ['rejected', 'missing', 'lost']) {
  test(`${failure} queue trigger leaves a durable retry for the next normal cron`, async t => {
    const f = setup(t);
    mockTransientFailures(f, 1);
    if (failure==='rejected') f.env.IMPORT_TRIGGER.send = async () => {throw new Error('queue unavailable');};
    if (failure==='missing') delete f.env.IMPORT_TRIGGER;
    await runQueue(f, webhook);
    assert.equal(importRow(f).processing_status, 'pending');
    assert.equal(Date.parse(importRow(f).next_attempt_at), f.state.now+TWO_MINUTES);
    f.state.now += 30*60_000;
    await runCron(f);
    assert.equal(f.state.aiCalls, 2);
    assert.equal(importRow(f).processing_status, 'staged');
    assert.ok(f.slots()[0].content);
  });
}

for (const deliveryTime of ['2030-01-10T02:00:30Z', '2030-01-10T14:00:00Z']) {
  test(`delayed message delivered at ${deliveryTime} cannot extract or publish yesterday's/closed work`, async t => {
    const f = setup(t, {now:'2030-01-10T01:58:30Z'});
    mockTransientFailures(f, 1);
    await runQueue(f, webhook);
    f.state.now = Date.parse(deliveryTime);
    const calls = f.state.calls.length;
    await runQueue(f, ...f.messages);
    assert.equal(f.state.calls.length, calls);
    await runCron(f);
    assert.equal(f.state.aiCalls, 1);
    assert.equal(importRow(f).failure_kind, 'expired');
    assert.ok(f.slots().every(slot => slot.content===''));
    assert.equal(f.messages.length, 1);
  });
}
