import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {harness} from '../workers/fb-feed/test-fixture.js';
import {importAlertObservation} from '../workers/fb-feed/alert-policy.js';
import {loadTs} from './load-ts.mjs';
const {dismissImport,restoreImport,lastDismissal}=loadTs('src/lib/automation-dismissal.ts');
const {readAutomationReview,importOutcome}=loadTs('src/lib/automation-review.ts');
const {POST,ALL}=loadTs('src/pages/admin/automation/dismiss.ts');
const source=JSON.parse(readFileSync('tests/fixtures/oct27-production.json','utf8'));
const now=new Date('2026-10-27T21:00:00Z'),day='2026-10-27',origin='https://grayznbuffalo.com';
const page=(await import('../dist/_worker.js/pages/admin/automation.astro.mjs')).page().default;
const container=await AstroContainer.create();
function setup(t,review='pending') {
  const f=harness(t,{now:now.toISOString(),candidate:source.daily});
  f.env.SESSIONS={get:async()=> '1'};
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,image_r2_key,candidate_json,extracted_json,processing_status,validation_result,review_status,fetched_at)
    VALUES('test','post','2026-10-27T15:00:00+0000','test.jpg',?,?,'staged','ok',?,'2026-10-27T15:01:00Z')`,JSON.stringify(source.dailyCandidate),JSON.stringify(source.daily),review);
  f.sql("INSERT INTO special_import_events(import_id,event_type,detail) VALUES('test','review','GUARDED_AUTO: 2026-10-27; reconciled 1 source(s); 2 slot(s)')");
  return f;
}
// Everything dismissal must never change: specials, defaults, sections, events and the import's evidence.
const snapshot=f=>({slots:f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),groups:f.sql('SELECT * FROM special_groups ORDER BY id'),
  collections:f.sql('SELECT * FROM special_collections ORDER BY id'),weeks:f.sql('SELECT * FROM weekly_specials ORDER BY id'),
  evidence:f.sql('SELECT id,fb_post_id,fb_created_time,image_r2_key,candidate_json,extracted_json,processing_status,validation_result FROM special_imports')});
const review=f=>f.sql("SELECT review_status FROM special_imports WHERE id='test'")[0].review_status;
const render=async f=>(await container.renderToResponse(page,{request:new Request(origin+'/admin/automation?date='+day,{headers:{cookie:'gb_session='+'a'.repeat(32)}}),locals:{runtime:{env:f.env,now}}})).text();
async function call(f,body,{authed=true,requestOrigin=origin}={}) {
  const request=new Request(origin+'/admin/automation/dismiss',{method:'POST',headers:{'Content-Type':'application/json',...(requestOrigin?{origin:requestOrigin}:{})},body:typeof body==='string'?body:JSON.stringify(body)});
  return POST({request,url:new URL(request.url),cookies:{get:()=>authed?{value:'a'.repeat(32)}:undefined},locals:{runtime:{env:f.env,now}}});
}

for(const prior of ['pending','accepted']) test(`dismiss (${prior}) changes only the review status, keeps evidence and history, and restore returns it`,async t=>{
  const f=setup(t,prior),before=snapshot(f),events=f.sql('SELECT * FROM special_import_events');
  await dismissImport(f.env,{importId:'test',reviewStatus:prior},now);
  assert.equal(review(f),'dismissed');assert.deepEqual(snapshot(f),before);
  const after=f.sql('SELECT * FROM special_import_events ORDER BY id');
  assert.deepEqual(after.slice(0,events.length),events);assert.match(after.at(-1).detail,/^STAFF_DISMISS:/);
  assert.equal((await restoreImport(f.env,{importId:'test'},now)).status,prior);
  assert.equal(review(f),prior);assert.deepEqual(snapshot(f),before);
  assert.match(f.sql('SELECT detail FROM special_import_events ORDER BY id DESC LIMIT 1')[0].detail,/^STAFF_RESTORE:/);
});

test('dismissed imports stop review alerts, and dismiss/restore audits never change the publication status',()=>{
  assert.equal(importAlertObservation({review_status:'dismissed',processing_status:'failed',failure_kind:'permanent'},{eligible:true,resolution:'unresolved'}).state,'suppressed');
  const published=[{event_type:'review',detail:'GUARDED_AUTO: 2026-10-27; reconciled 1 source(s); 2 slot(s)'}];
  const withAudit=[{event_type:'review',detail:'STAFF_RESTORE:{}'},{event_type:'review',detail:'STAFF_DISMISS:{"previous":"pending"}'},...published];
  assert.equal(importOutcome({processing_status:'staged'},withAudit).status,importOutcome({processing_status:'staged'},published).status);
  assert.equal(lastDismissal([{event_type:'review',detail:'STAFF_DISMISS:{"previous":"accepted"}'}]).previous,'accepted');
  assert.equal(lastDismissal([{event_type:'review',detail:'STAFF_DISMISS:{"previous":"dismissed"}'}]),null);
});

test('stale, in-progress, unknown and repeated requests fail without writes',async t=>{
  const f=setup(t);const count=()=>f.sql('SELECT count(*) n FROM special_import_events')[0].n,n=count();
  await assert.rejects(()=>dismissImport(f.env,{importId:'test',reviewStatus:'accepted'},now),/changed/);
  await assert.rejects(()=>dismissImport(f.env,{importId:'missing',reviewStatus:'pending'},now),/no longer exists/);
  await assert.rejects(()=>dismissImport(f.env,{importId:"x' OR 1=1",reviewStatus:'pending'},now));
  await assert.rejects(()=>dismissImport(f.env,{importId:'test',reviewStatus:'dismissed'},now));
  await assert.rejects(()=>restoreImport(f.env,{importId:'test'},now),/changed/);
  f.sql("UPDATE special_imports SET processing_status='processing'");
  await assert.rejects(()=>dismissImport(f.env,{importId:'test',reviewStatus:'pending'},now),/still working/);
  f.sql("UPDATE special_imports SET processing_status='staged'");
  await dismissImport(f.env,{importId:'test',reviewStatus:'pending'},now);
  await assert.rejects(()=>dismissImport(f.env,{importId:'test',reviewStatus:'pending'},now),/changed/);
  assert.equal(count(),n+1);assert.equal(review(f),'dismissed');
});

test('page hides dismissed posts from the review list and offers Restore in a collapsed history',async t=>{
  const f=setup(t);
  let html=await render(f);
  assert.match(html,/data-action="dismiss"/);assert.match(html,/Remove this post from your review list\?/);
  assert.doesNotMatch(html,/Dismissed posts \(/);
  await dismissImport(f.env,{importId:'test',reviewStatus:'pending'},now);
  html=await render(f);
  assert.match(html,/<details class="review-panel dismissed"[^>]*>\s*<summary[^>]*>Dismissed posts \(1\)/);
  assert.match(html,/data-action="restore"/);assert.doesNotMatch(html,/data-action="dismiss"/);
  assert.doesNotMatch(html,/data-approval-form/);assert.match(html,/No posts left to review/);
  assert.match(html,/Staff removed this post from the review list/);
});

test('dismiss HTTP requires a signed-in same-origin JSON request and is no-store',async t=>{
  const f=setup(t);
  assert.equal((await call(f,{action:'dismiss',importId:'test',reviewStatus:'pending'},{authed:false})).status,401);
  for(const requestOrigin of ['https://evil.example',null]) assert.equal((await call(f,{action:'dismiss',importId:'test',reviewStatus:'pending'},{requestOrigin})).status,403);
  assert.equal((await call(f,'{')).status,400);assert.equal((await call(f,{action:'delete',importId:'test'})).status,400);
  assert.equal((await call(f,' '.repeat(2001))).status,413);assert.equal((await ALL({})).status,405);
  assert.equal(review(f),'pending');
  const ok=await call(f,{action:'dismiss',importId:'test',reviewStatus:'pending'});
  assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'no-store');assert.equal(review(f),'dismissed');
  assert.equal((await call(f,{action:'dismiss',importId:'test',reviewStatus:'pending'})).status,409);
  assert.equal((await (await call(f,{action:'restore',importId:'test'})).json()).status,'pending');
});
