import assert from 'node:assert/strict';
import test from 'node:test';
import {harness} from './test-fixture.js';

test('vision binding receives top-level base64 image and persists extraction response', async t => {
  const f = harness(t);
  const raw = JSON.stringify(f.state.candidate);
  t.mock.method(f.env.AI, 'run', async (model, params) => {
    assert.equal(model, '@cf/meta/llama-3.2-11b-vision-instruct');
    assert.equal(params.image, 'data:image/jpeg;base64,/9j/');
    assert.equal(params.max_tokens, 2048);
    assert.deepEqual(params.messages.map(m => m.role), ['system', 'user']);
    assert.ok(params.messages.every(m => typeof m.content === 'string'));
    assert.match(params.messages[1].content, /Extract ALL offers once each/);
    return {response: raw};
  });
  await f.run();
  assert.equal(f.env.AI.run.mock.callCount(), 1);
  assert.equal(f.imports()[0].extracted_json, raw);
  assert.equal(f.imports()[0].last_error, null);
});

test('AI call includes response_format json_object to prevent prose responses', async t => {
  const f = harness(t);
  t.mock.method(f.env.AI, 'run', async (_model, params) => {
    assert.deepEqual(params.response_format, { type: 'json_object' });
    return { response: JSON.stringify(f.state.candidate) };
  });
  await f.run();
  assert.equal(f.env.AI.run.mock.callCount(), 1);
});

test('image-only post (empty caption) with correct structured JSON produces staged ok', async t => {
  const {offer, poster, harness: h} = await import('./test-fixture.js');
  const f = h(t, {caption: ''});
  // Override AI to return well-formed evidence JSON for a Wednesday night poster
  t.mock.method(f.env.AI, 'run', async () => ({
    response: JSON.stringify(f.state.candidate),
  }));
  await f.run();
  const row = f.imports()[0];
  assert.equal(row.processing_status, 'staged');
  assert.equal(row.validation_result, 'ok');
});

test('prose AI response (not JSON) still produces validation_result=rejected', async t => {
  const f = harness(t);
  t.mock.method(f.env.AI, 'run', async () => ({
    response: 'Here are the Wednesday Night Specials: Wing Night featuring bone-in and boneless options.',
  }));
  await f.run();
  const row = f.imports()[0];
  assert.equal(row.processing_status, 'failed');
  assert.equal(row.validation_result, 'rejected');
  assert.match(row.validation_reason, /not valid JSON/);
});

test('AI thrown error is retained in the import, audit and logs with credentials redacted', async t => {
  const f = harness(t);
  f.env.FB_SYSTEM_TOKEN = 'private-facebook-credential';
  t.mock.method(f.env.AI, 'run', async () => {
    throw new Error('503 upstream unavailable; Bearer private-auth-credential; access_token=private-query-credential; private-facebook-credential');
  });
  await f.run();
  const row = f.imports()[0];
  assert.equal(row.processing_status, 'failed');
  assert.equal(row.validation_result, 'rejected');
  assert.equal(row.extracted_json, null);
  assert.match(row.last_error, /503 upstream unavailable/);
  assert.equal(row.validation_reason, row.last_error);
  const events = f.sql("SELECT detail FROM special_import_events WHERE import_id=? AND event_type='error'", row.id);
  assert.deepEqual(events, [{detail: row.last_error}]);
  const logs = JSON.stringify(console.error.mock.calls.map(c => c.arguments));
  assert.match(logs, /503 upstream unavailable/);
  assert.doesNotMatch(JSON.stringify({row, events, logs}), /private-(auth|query|facebook)-credential/);
  assert.ok(f.slots().every(s => s.content === ''));
});
