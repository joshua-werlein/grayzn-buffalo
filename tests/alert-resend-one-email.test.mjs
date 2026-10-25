import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {arm,sendOnce,status,testMessage,CONFIRMATION,ARM_WINDOW_MS} from '../scripts/alert-resend-one-email.mjs';
import {resendIdempotencyKey} from '../workers/fb-feed/alert-resend.js';

// Mocked provider only. Any use of the real global fetch is refused.
const outbound=[],realFetch=globalThis.fetch;
globalThis.fetch=async(...args)=>{outbound.push(args);throw Error('Outbound network is disabled in alert tests');};
const dir=mkdtempSync(join(tmpdir(),'gb-alert-once-'));
after(()=>{globalThis.fetch=realFetch;rmSync(dir,{recursive:true,force:true});});

const RECIPIENT='owner@example.test',ID='49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';
const ENV={ALERT_RESEND_API_KEY:'re_fakeTestKey_000000000000',SPECIALS_ALERT_FROM:'alerts@grayznbuffalo.com',SPECIALS_ALERT_TO:RECIPIENT};
const digest=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(b=>b.toString(16).padStart(2,'0')).join('');
let n=0;
async function setup(respond=()=>new Response(JSON.stringify({id:ID}),{status:200})) {
  const guard=join(dir,`guard-${++n}.sqlite`),calls=[];
  arm(guard,{runId:'test-20261025-one-email'});
  const options={confirm:CONFIRMATION,recipientSha256:await digest(RECIPIENT),fetch:async(url,init)=>{calls.push({url,init});return respond();}};
  return {guard,calls,options,send:(extra={})=>sendOnce(guard,ENV,{...options,...extra})};
}

test('arming is bounded to 15 minutes, validated and never repeated',async()=>{
  const guard=join(dir,'arm.sqlite');
  assert.throws(()=>arm(guard,{runId:'production'}),/Run id/);
  assert.throws(()=>arm(guard,{runId:'test-x',expiresInMs:ARM_WINDOW_MS+1}),/15 minutes/);
  arm(guard,{runId:'test-x',now:1000});assert.equal(status(guard).state,'armed');assert.equal(status(guard).expires_ms,1000+ARM_WINDOW_MS);
  assert.throws(()=>arm(guard,{runId:'test-x'}),/never rearmed/);
});

test('concurrent and repeated sends make exactly one request with a test-run idempotency key',async()=>{
  const f=await setup();
  const results=await Promise.all(Array.from({length:6},()=>f.send()));
  assert.equal(results.filter(r=>r.state==='accepted').length,1);assert.equal(f.calls.length,1);
  const saved=status(f.guard);
  assert.equal(saved.run_id,'test-20261025-one-email');assert.equal(saved.state,'accepted');assert.equal(saved.provider_message_id,ID);
  const body=JSON.parse(f.calls[0].init.body),day=body.subject.slice(-10);
  assert.deepEqual(body,{from:'alerts@grayznbuffalo.com',to:[RECIPIENT],...testMessage(day)});
  const key=f.calls[0].init.headers['Idempotency-Key'];
  assert.equal(key,await resendIdempotencyKey(`${day}:resend_test:automation_failed`,'test-20261025-one-email'));
  assert.notEqual(key,await resendIdempotencyKey(`${day}:resend_test:automation_failed`));
  assert.equal((await f.send()).state,'already-used-or-expired');assert.equal(f.calls.length,1);
});

test('missing confirmation, unapproved recipient or bad configuration cannot consume the guard',async()=>{
  const f=await setup();
  assert.equal((await f.send({confirm:undefined})).state,'not-confirmed');
  assert.equal((await f.send({confirm:CONFIRMATION.toUpperCase()})).state,'not-confirmed');
  // Without the test seam only the approved production recipient digest is accepted.
  assert.equal((await f.send({recipientSha256:undefined})).state,'unconfigured');
  assert.equal((await sendOnce(f.guard,{...ENV,ALERT_RESEND_API_KEY:undefined},f.options)).state,'unconfigured');
  assert.equal((await sendOnce(f.guard,{...ENV,SPECIALS_ALERT_FROM:'noreply@grayznbuffalo.com'},f.options)).state,'unconfigured');
  assert.equal((await sendOnce(join(dir,'missing.sqlite'),ENV,f.options)).state,'no-guard');
  assert.equal(f.calls.length,0);assert.equal(status(f.guard).state,'armed');
});

test('expired guard fails closed',async()=>{
  const f=await setup();
  assert.equal((await f.send({now:Date.now()+ARM_WINDOW_MS+1})).state,'already-used-or-expired');assert.equal(f.calls.length,0);
});

for(const [name,respond] of [
  ['network error',()=>Promise.reject(TypeError('fetch failed'))],
  ['HTTP 429',()=>new Response('{}',{status:429})],
  ['HTTP 500',()=>new Response('{}',{status:500})],
  ['missing id',()=>new Response('{}',{status:200})],
]) test(`${name} stays uncertain and is never retried`,async()=>{
  const f=await setup(respond);
  assert.deepEqual(await f.send(),{state:'uncertain'});assert.equal(status(f.guard).state,'uncertain');
  assert.equal((await f.send()).state,'already-used-or-expired');assert.equal(f.calls.length,1);
});

test('no outbound request reached the real network',()=>{assert.equal(outbound.length,0);});
