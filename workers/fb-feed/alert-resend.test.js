import test, {after,before} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {alertTransport,emailTransport} from './alert-email.js';
import {RESEND_ENDPOINT,RESEND_RECIPIENT_SHA256,RESEND_SENDER,RESEND_TIMEOUT_MS,resendConfig,resendIdempotencyKey} from './alert-resend.js';
import {recordAlertObservation,dispatchAlert,ALERT_GRACE_MS,ALERT_LEASE_MS,ALERT_SEND_TIMEOUT_MS} from './alert-store.js';
import {deliveryWindow} from '../../src/lib/delivery.js';

// Every provider call below uses an injected fake. Any accidental use of the
// real global fetch is refused and fails this file.
const outbound=[],realFetch=globalThis.fetch;
globalThis.fetch=async(...args)=>{outbound.push(args);throw Error('Outbound network is disabled in alert tests');};
after(()=>{globalThis.fetch=realFetch;});

const RECIPIENT='owner@example.test',KEY='re_fakeTestKey_000000000000';
const ID='49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';
const ENV=Object.freeze({SPECIALS_ALERT_MODE:'EMAIL',SPECIALS_ALERT_EMAIL_APPROVED:'true',SPECIALS_ALERT_PROVIDER:'RESEND',
  SPECIALS_ALERT_FROM:'alerts@grayznbuffalo.com',SPECIALS_ALERT_TO:RECIPIENT,ALERT_RESEND_API_KEY:KEY});
const INCIDENT='2030-01-09:daily:publication_blocked';
const MESSAGE=Object.freeze({incidentKey:INCIDENT,day:'2030-01-09',code:'publication_blocked',
  message:'untrusted <b>content</b>',reviewUrl:'https://attacker.example'});
const sha256=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(b=>b.toString(16).padStart(2,'0')).join('');
let DIGEST;before(async()=>{DIGEST=await sha256(RECIPIENT);});

const accepted=(id=ID)=>new Response(JSON.stringify({id}),{status:200,headers:{'content-type':'application/json'}});
function provider(respond=()=>accepted()) {
  const calls=[];
  return {calls,fetch:async(url,init)=>{calls.push({url,init});return respond(calls.length,init);}};
}
const transport=(overrides={},fetch)=>alertTransport({...ENV,...overrides},{fetch,recipientSha256:DIGEST});

test('Resend success posts one fixed request and returns the provider message id',async()=>{
  const p=provider(),send=await transport({},p.fetch);
  assert.deepEqual(await send({...MESSAGE,signal:new AbortController().signal}),{provider:'resend',id:ID});
  assert.equal(p.calls.length,1);
  const [{url,init}]=p.calls;
  assert.equal(url,RESEND_ENDPOINT);assert.equal(url,'https://api.resend.com/emails');
  assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(init.headers).sort(),['Authorization','Content-Type','Idempotency-Key']);
  assert.equal(init.headers.Authorization,`Bearer ${KEY}`);assert.equal(init.headers['Content-Type'],'application/json');
  assert.equal(init.headers['Idempotency-Key'],await resendIdempotencyKey(INCIDENT));
  assert.deepEqual(JSON.parse(init.body),{from:'alerts@grayznbuffalo.com',to:[RECIPIENT],
    subject:"Grayz'n Buffalo automation needs review — 2030-01-09",
    text:'Available Facebook evidence could not be fully published.\nDate: 2030-01-09 (Chicago)\nStage: publication\n\n'
      +'Automatic retry: none pending\nCorrection: needed. Review the held imports and use Approve & Publish; approved values are protected from automation. The specials editor is also available.\n'
      +'Open: https://grayznbuffalo.com/admin/specials\nReview imports: https://grayznbuffalo.com/admin/automation?date=2030-01-09'});
  assert.ok(!init.body.includes('untrusted') && !init.body.includes('attacker'));
});

test('alerts OFF/OBSERVE, missing approval, invalid provider and invalid configuration select nothing',async()=>{
  const p=provider();
  for(const overrides of [
    {SPECIALS_ALERT_MODE:undefined},{SPECIALS_ALERT_MODE:'OFF'},{SPECIALS_ALERT_MODE:'OBSERVE'},{SPECIALS_ALERT_MODE:'MOCK'},{SPECIALS_ALERT_MODE:'email'},
    {SPECIALS_ALERT_EMAIL_APPROVED:undefined},{SPECIALS_ALERT_EMAIL_APPROVED:'false'},{SPECIALS_ALERT_EMAIL_APPROVED:'TRUE'},{SPECIALS_ALERT_EMAIL_APPROVED:true},
    {SPECIALS_ALERT_PROVIDER:'resend'},{SPECIALS_ALERT_PROVIDER:'Resend'},{SPECIALS_ALERT_PROVIDER:' RESEND'},{SPECIALS_ALERT_PROVIDER:''},
    {SPECIALS_ALERT_PROVIDER:'SENDGRID'},{SPECIALS_ALERT_PROVIDER:'CLOUDFLARE'},{SPECIALS_ALERT_PROVIDER:null},
    {ALERT_RESEND_API_KEY:undefined},{ALERT_RESEND_API_KEY:''},{ALERT_RESEND_API_KEY:'re_short'},{ALERT_RESEND_API_KEY:'sk_live_0000000000000'},
    {ALERT_RESEND_API_KEY:` ${KEY}`},{ALERT_RESEND_API_KEY:`${KEY}\r\nX-Injected: 1`},{ALERT_RESEND_API_KEY:'re_'+'a'.repeat(300)},
    {SPECIALS_ALERT_FROM:undefined},{SPECIALS_ALERT_FROM:'noreply@grayznbuffalo.com'},{SPECIALS_ALERT_FROM:'ALERTS@grayznbuffalo.com'},
    {SPECIALS_ALERT_FROM:'Alerts <alerts@grayznbuffalo.com>'},{SPECIALS_ALERT_FROM:'alerts@grayznbuffalo.com.attacker.example'},{SPECIALS_ALERT_FROM:'alerts@attacker.example'},
    {SPECIALS_ALERT_TO:undefined},{SPECIALS_ALERT_TO:'other@example.test'},{SPECIALS_ALERT_TO:'OWNER@example.test'},{SPECIALS_ALERT_TO:[RECIPIENT]},
    {SPECIALS_ALERT_TO:`${RECIPIENT}\r\nBcc: attacker@example.com`},{SPECIALS_ALERT_TO:`${RECIPIENT},attacker@example.com`},
  ]) assert.equal(await transport(overrides,p.fetch),null,JSON.stringify(overrides));
  assert.equal(p.calls.length,0);
});

test('only the approved recipient digest is accepted; configuration cannot replace it',async()=>{
  assert.match(RESEND_RECIPIENT_SHA256,/^[0-9a-f]{64}$/);assert.notEqual(RESEND_RECIPIENT_SHA256,DIGEST);
  assert.equal(RESEND_SENDER,'alerts@grayznbuffalo.com');
  const p=provider();
  assert.equal(await alertTransport(ENV,{fetch:p.fetch}),null);
  assert.equal(await alertTransport({...ENV,recipientSha256:DIGEST,RESEND_RECIPIENT_SHA256:DIGEST},{fetch:p.fetch}),null);
  assert.equal(await resendConfig(ENV),null);
  assert.equal(await resendConfig(ENV,{recipientSha256:DIGEST,namespace:'staging'}),null);
  assert.deepEqual({...await resendConfig(ENV,{recipientSha256:DIGEST})},{key:KEY,from:RESEND_SENDER,to:RECIPIENT,namespace:'production'});
  assert.equal(p.calls.length,0);
});

test('no provider fallback in either direction',async()=>{
  let native=0;const binding={send:async()=>{native++;return {messageId:'native'};}};
  const p=provider(()=>Promise.reject(TypeError('fetch failed')));
  // Selected Resend with incomplete configuration never uses the native binding.
  assert.equal(await transport({ALERT_RESEND_API_KEY:undefined,ALERT_EMAIL:binding},p.fetch),null);
  // A failed Resend request never falls back to the native binding.
  await assert.rejects((await transport({ALERT_EMAIL:binding},p.fetch))(MESSAGE),/^Error: Resend request failed$/);
  // Unknown providers and direct native selection with an explicit provider both fail closed.
  assert.equal(await transport({SPECIALS_ALERT_PROVIDER:'SENDGRID',ALERT_EMAIL:binding},p.fetch),null);
  assert.equal(emailTransport({...ENV,ALERT_EMAIL:binding}),null);
  assert.equal(native,0);assert.equal(p.calls.length,1);
  // The default (absent) provider keeps the native binding, even if a Resend key exists.
  const nativeSend=await transport({SPECIALS_ALERT_PROVIDER:undefined,ALERT_EMAIL:binding},p.fetch);
  await nativeSend(MESSAGE);assert.equal(native,1);assert.equal(p.calls.length,1);
});

test('pre-aborted signal prevents any request',async()=>{
  const p=provider(),send=await transport({},p.fetch),controller=new AbortController();controller.abort();
  await assert.rejects(send({...MESSAGE,signal:controller.signal}));
  assert.equal(p.calls.length,0);
});

test('network errors and timeouts fail with a fixed message after one attempt',async()=>{
  const network=provider(()=>Promise.reject(TypeError(`connect failed using ${KEY}`)));
  await assert.rejects((await transport({},network.fetch))(MESSAGE),e=>e.message==='Resend request failed');
  assert.equal(network.calls.length,1);
  const hanging=provider((n,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason))));
  const started=Date.now();
  await assert.rejects((await transport({},hanging.fetch))({...MESSAGE,signal:AbortSignal.timeout(20)}),e=>e.message==='Resend request failed');
  assert.ok(Date.now()-started<RESEND_TIMEOUT_MS);assert.equal(hanging.calls.length,1);
  // Without a caller signal the request is still bounded by the provider cap.
  const uncapped=provider((n,init)=>{assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted);return accepted();});
  await (await transport({},uncapped.fetch))(MESSAGE);
  assert.equal(RESEND_TIMEOUT_MS,ALERT_SEND_TIMEOUT_MS);
});

test('HTTP 3xx, 401, 403, 409, 422, 429 and 5xx responses never resolve and leak nothing',async()=>{
  for(const status of [301,307,400,401,403,404,409,422,429,500,502,503,504]) {
    const p=provider(()=>new Response(JSON.stringify({id:ID,name:'provider_error',message:`secret detail ${KEY}`}),{status,headers:status<400?{location:'https://attacker.example'}:{}}));
    await assert.rejects((await transport({},p.fetch))(MESSAGE),e=>e.message===`Resend rejected alert (HTTP ${status})`);
    assert.equal(p.calls.length,1,String(status));
  }
});

test('acceptance requires a valid Resend message id',async()=>{
  for(const body of ['{}','{"id":""}','{"id":123}','{"id":null}','{"id":"abc"}',`{"messageId":"${ID}"}`,
    `{"id":"${ID}\\r\\nX: 1"}`,'[]','null','not json','']) {
    const p=provider(()=>new Response(body,{status:200}));
    await assert.rejects((await transport({},p.fetch))(MESSAGE),e=>e.message==='Resend acceptance unconfirmed',body);
    assert.equal(p.calls.length,1);
  }
});

test('idempotency keys are stable per incident, namespaced and bounded',async()=>{
  const production=await resendIdempotencyKey(INCIDENT);
  assert.equal(production,await resendIdempotencyKey(INCIDENT,'production'));
  assert.notEqual(production,await resendIdempotencyKey('2030-01-10:daily:publication_blocked'));
  assert.notEqual(production,await resendIdempotencyKey('2030-01-09:delivery:delivery_failed'));
  const harness=await resendIdempotencyKey(INCIDENT,'test-20261025-one-email');
  assert.notEqual(production,harness);assert.equal(harness,await resendIdempotencyKey(INCIDENT,'test-20261025-one-email'));
  for(const key of [production,harness]) {assert.ok(key.length<=256);assert.match(key,/^grayzn-fb-alert-v1-[0-9a-f]{64}$/);}
  for(const [incident,namespace] of [['bad','production'],['',undefined],[null,undefined],[`${INCIDENT}\n`,undefined],
    [INCIDENT,'staging'],[INCIDENT,'test-'],[INCIDENT,'test-UPPER'],[INCIDENT,'production\n'],[INCIDENT,null]])
    await assert.rejects(resendIdempotencyKey(incident,namespace),/Invalid alert identity/);
  // An operator-reviewed replay of one incident carries the identical key and frozen content.
  const p=provider();
  await (await transport({},p.fetch))(MESSAGE);await (await transport({},p.fetch))(MESSAGE);
  assert.equal(p.calls[0].init.headers['Idempotency-Key'],p.calls[1].init.headers['Idempotency-Key']);
  assert.equal(p.calls[0].init.body,p.calls[1].init.body);
  // Malformed incident identity fails before any request.
  const q=provider();
  await assert.rejects((await transport({},q.fetch))({...MESSAGE,incidentKey:'unexpected'}));assert.equal(q.calls.length,0);
});

// Durable store integration: the Resend adapter behind the existing D1 fences.
const migration=readFileSync(new URL('../../migrations/0023_facebook_alert_incidents.sql',import.meta.url),'utf8');
function store(t,date='2026-10-22T15:00:00Z') {
  const sql=new DatabaseSync(':memory:');sql.exec(migration);t.after(()=>sql.close());
  const DB={prepare(query) {
    const s=sql.prepare(query);let values=[];
    const args=()=>Object.fromEntries(values.map((v,i)=>[String(i+1),v]));
    return {bind(...v){values=v;return this;},async run(){return {meta:{changes:Number(s.run(args()).changes)}};},async first(){return s.get(args())??null;}};
  }};
  let clock=Date.parse(date);
  const now=()=>clock;
  return {DB,now,advance:ms=>clock+=ms,
    record:(state='attention')=>recordAlertObservation(DB,{day:deliveryWindow(new Date(clock)).day,scope:'daily',code:'publication_blocked',state,observedAt:clock}),
    dispatch:(send,extra={})=>dispatchAlert(DB,send,{enabled:true,now,...extra}),
    row:()=>sql.prepare('SELECT * FROM facebook_alert_incidents').get()};
}

test('D1 dispatch: Resend acceptance sends exactly once across concurrent and repeated dispatch',async t=>{
  const f=store(t),p=provider(),send=await transport({},p.fetch);
  await f.record();f.advance(ALERT_GRACE_MS);
  const results=await Promise.all(Array.from({length:8},()=>f.dispatch(send)));
  assert.equal(results.filter(r=>r.status==='sent').length,1);assert.equal(p.calls.length,1);
  assert.equal(f.row().dispatch_state,'sent');assert.notEqual(f.row().sent_ms,null);
  assert.equal(p.calls[0].init.headers['Idempotency-Key'],await resendIdempotencyKey(f.row().incident_key));
  f.advance(ALERT_LEASE_MS+1);await f.record();f.advance(ALERT_GRACE_MS);
  assert.equal((await f.dispatch(send)).status,'idle');assert.equal(p.calls.length,1);
});

for(const [name,respond] of [
  ['network error',()=>Promise.reject(TypeError('fetch failed'))],
  ...[401,403,409,422,429,500,503].map(status=>[`HTTP ${status}`,()=>new Response('{"message":"x"}',{status})]),
  ['missing message id',()=>new Response('{}',{status:200})],
  ['malformed response',()=>new Response('<html>',{status:200})],
]) test(`D1 dispatch: ${name} leaves durable uncertainty and is never retried`,async t=>{
  const f=store(t),p=provider(respond),send=await transport({},p.fetch);
  await f.record();f.advance(ALERT_GRACE_MS);
  assert.equal((await f.dispatch(send)).status,'uncertain');
  assert.equal(f.row().dispatch_state,'uncertain');assert.equal(f.row().last_error,'send_failed');assert.equal(f.row().sent_ms,null);
  f.advance(ALERT_LEASE_MS+1);assert.equal((await f.dispatch(send)).status,'idle');
  // Recovery and recurrence cannot rearm the quarantined incident.
  f.advance(1);await f.record('resolved');f.advance(1);await f.record();f.advance(ALERT_GRACE_MS);
  assert.equal((await f.dispatch(send)).status,'idle');
  assert.equal(p.calls.length,1);assert.equal(f.row().dispatch_state,'uncertain');
});

test('D1 dispatch: quarantine outlives the 24-hour provider idempotency window',async t=>{
  const f=store(t),p=provider(()=>new Response('',{status:500})),send=await transport({},p.fetch);
  await f.record();f.advance(ALERT_GRACE_MS);await f.dispatch(send);
  const key=f.row().incident_key;
  f.advance(25*3600000);await f.dispatch(send);
  assert.equal(p.calls.length,1);assert.equal(f.row().incident_key,key);assert.equal(f.row().dispatch_state,'uncertain');
});

test('D1 dispatch: timeout is uncertain; late acceptance acknowledges without a second request',async t=>{
  const f=store(t);let accept;
  const p=provider(()=>new Promise(resolve=>{accept=()=>resolve(accepted());}));
  const send=await transport({},p.fetch);
  await f.record();f.advance(ALERT_GRACE_MS);
  assert.equal((await f.dispatch(send,{timeoutMs:10})).status,'uncertain');
  f.advance(ALERT_LEASE_MS+1);await Promise.all(Array.from({length:4},()=>f.dispatch(send,{timeoutMs:10})));
  assert.equal(p.calls.length,1);
  accept();await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(f.row().dispatch_state,'sent');assert.equal(p.calls.length,1);
});

test('D1 dispatch: an aborted request stays quarantined',async t=>{
  const f=store(t);
  const p=provider((n,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason))));
  const send=await transport({},p.fetch);
  await f.record();f.advance(ALERT_GRACE_MS);
  assert.equal((await f.dispatch(send,{timeoutMs:10})).status,'uncertain');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(f.row().dispatch_state,'uncertain');assert.equal(f.row().last_error,'send_failed');
  f.advance(ALERT_LEASE_MS+1);await f.dispatch(send);assert.equal(p.calls.length,1);
});

// Real workerd runtime (redirect mode, AbortSignal.any, WebCrypto). Miniflare's
// outbound service intercepts every subrequest; nothing reaches the network.
test('workerd runtime: adapter request, redirect refusal and timeout with intercepted outbound',async t=>{
  const requests=[];let respond;
  const root=fileURLToPath(new URL('.',import.meta.url));
  const mf=new Miniflare({compatibilityDate:'2026-01-01',modulesRoot:root,modules:[
    {type:'ESModule',path:`${root}resend-runtime-check.mjs`,contents:`import {resendConfig,sendResendEmail} from './alert-resend.js';
      export default {async fetch(request,env){
        const {digest,timeout}=await request.json();
        const config=await resendConfig(env,{recipientSha256:digest});
        if(!config) return Response.json({ok:false,error:'unconfigured'});
        try {
          return Response.json({ok:true,result:await sendResendEmail(config,{incidentKey:'${INCIDENT}',subject:'s',text:'t',
            signal:timeout?AbortSignal.timeout(timeout):undefined})});
        } catch(e) {return Response.json({ok:false,error:e.message});}
      }};`},
    {type:'ESModule',path:`${root}alert-resend.js`,contents:readFileSync(new URL('./alert-resend.js',import.meta.url),'utf8')},
  ],bindings:{SPECIALS_ALERT_FROM:'alerts@grayznbuffalo.com',SPECIALS_ALERT_TO:RECIPIENT,ALERT_RESEND_API_KEY:KEY},
  outboundService:async request=>{requests.push({url:request.url,method:request.method,headers:Object.fromEntries(request.headers),body:await request.text()});return respond();}});
  t.after(()=>mf.dispose());
  const call=async body=>(await mf.dispatchFetch('http://local.test/',{method:'POST',body:JSON.stringify({digest:DIGEST,...body})})).json();
  respond=()=>accepted();
  assert.deepEqual(await call({}),{ok:true,result:{provider:'resend',id:ID}});
  assert.equal(requests.length,1);assert.equal(requests[0].url,RESEND_ENDPOINT);assert.equal(requests[0].method,'POST');
  assert.equal(requests[0].headers.authorization,`Bearer ${KEY}`);
  assert.equal(requests[0].headers['idempotency-key'],await resendIdempotencyKey(INCIDENT));
  assert.deepEqual(JSON.parse(requests[0].body),{from:RESEND_SENDER,to:[RECIPIENT],subject:'s',text:'t'});
  respond=()=>new Response(null,{status:307,headers:{location:'https://attacker.example/emails'}});
  assert.deepEqual(await call({}),{ok:false,error:'Resend rejected alert (HTTP 307)'});
  assert.equal(requests.length,2);
  respond=()=>new Promise(resolve=>setTimeout(()=>resolve(accepted()),1000));
  assert.deepEqual(await call({timeout:50}),{ok:false,error:'Resend request failed'});
  assert.deepEqual(await call({digest:RESEND_RECIPIENT_SHA256}),{ok:false,error:'unconfigured'});
  assert.equal(requests.length,3);
});

test('no outbound request reached the real network',()=>{assert.equal(outbound.length,0);});
