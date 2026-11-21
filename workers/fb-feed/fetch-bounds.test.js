// November 21 maintenance: outbound Graph and image fetches are time-bounded and
// import images are read with a byte cap. A stalled or oversized response fails
// closed (incomplete scan / no usable image) and never publishes.
import assert from 'node:assert/strict';
import test from 'node:test';
import {harness} from './test-fixture.js';
import {readCappedBody,IMAGE_MAX_BYTES} from './worker.js';
import {IMPORT_RETRY_MS} from './recovery.js';

const row=f=>f.imports()[0];
/** Make every AbortSignal.timeout fire almost immediately, as a real timeout would. */
function fastTimeouts(t) {
  const requested=[];
  t.mock.method(AbortSignal,'timeout',ms=>{
    requested.push(ms);const c=new AbortController();
    setTimeout(()=>c.abort(new DOMException('The operation was aborted due to timeout','TimeoutError')),5);
    return c.signal;
  });
  return requested;
}
/** A response that never arrives unless its signal aborts it. */
const stalled=init=>new Promise((_,reject)=>{
  if(!init?.signal) return;   // Without a signal this would hang the test, which is the defect.
  init.signal.addEventListener('abort',()=>reject(init.signal.reason));
});
function endless(chunk=1024*1024) {
  const state={pulled:0,cancelled:false};
  const stream=new ReadableStream({pull(c){state.pulled+=chunk;c.enqueue(new Uint8Array(chunk).fill(255));},cancel(){state.cancelled=true;}});
  return {stream,state};
}

test('capped body reader stops at the limit with or without an honest Content-Length',async()=>{
  const small=await readCappedBody(new Response(new Uint8Array([1,2,3])),10);
  assert.deepEqual([...small],[1,2,3]);
  const declared=endless();
  assert.equal(await readCappedBody(new Response(declared.stream,{headers:{'content-length':String(IMAGE_MAX_BYTES+1)}}),IMAGE_MAX_BYTES),null);
  assert.ok(declared.state.cancelled);assert.equal(declared.state.pulled<=2*1024*1024,true);
  const undeclared=endless();
  assert.equal(await readCappedBody(new Response(undeclared.stream),IMAGE_MAX_BYTES),null);
  assert.ok(undeclared.state.cancelled);assert.ok(undeclared.state.pulled<=IMAGE_MAX_BYTES+4*1024*1024);
  const lying=endless();
  assert.equal(await readCappedBody(new Response(lying.stream,{headers:{'content-length':'3'}}),IMAGE_MAX_BYTES),null);
});

test('a stalled import image times out as a transient image failure, then recovers on retry',async t=>{
  const f=harness(t);const requested=fastTimeouts(t);const fetch=globalThis.fetch;let stall=true;
  t.mock.method(globalThis,'fetch',(input,init)=>String(input).includes('graph.facebook.com')||!stall ? fetch(input,init) : stalled(init));
  await f.run();
  assert.equal(row(f).failure_kind,'transient_image');assert.equal(row(f).image_r2_key,null);assert.equal(f.state.aiCalls,0);
  assert.ok(requested.length>=2,'Graph scan and image fetch both carry a timeout');
  stall=false;f.state.now+=IMPORT_RETRY_MS;await f.run();
  assert.equal(row(f).processing_status,'staged');assert.equal(f.state.aiCalls,1);
  assert.ok(f.slots()[0].content,'the recovered poster publishes as before');
});

test('a stalled Graph scan is an incomplete scan: the run ends and nothing is imported or published',async t=>{
  const f=harness(t);fastTimeouts(t);
  t.mock.method(globalThis,'fetch',(input,init)=>stalled(init));
  await f.run();
  assert.equal(f.imports().length,0);assert.equal(f.state.aiCalls,0);assert.equal(f.slots()[0].content,'');
});

test('an endless import image body is rejected near the cap, never buffered whole, and never reaches AI',async t=>{
  const f=harness(t);const fetch=globalThis.fetch;const body=endless();
  t.mock.method(globalThis,'fetch',(input,init)=>String(input).includes('graph.facebook.com') ? fetch(input,init)
    : Promise.resolve(new Response(body.stream,{headers:{'content-type':'image/jpeg'}})));
  await f.run();
  // Stream read-ahead may pull a few chunks past the cap before cancellation.
  assert.ok(body.state.cancelled);assert.ok(body.state.pulled<=IMAGE_MAX_BYTES+4*1024*1024);
  assert.equal(row(f).validation_reason,'invalid or oversized image');assert.equal(f.state.aiCalls,0);assert.equal(row(f).image_r2_key,null);assert.equal(f.slots()[0].content,'');
});
