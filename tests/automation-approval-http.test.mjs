import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadTs} from './load-ts.mjs';
import {harness} from '../workers/fb-feed/test-fixture.js';
const {POST,ALL}=loadTs('src/pages/admin/automation/approve.ts');
const {approvalModel}=loadTs('src/lib/automation-approval.ts');
const source=JSON.parse(readFileSync('tests/fixtures/oct27-production.json','utf8'));
const now=new Date('2026-10-27T21:00:00Z'),origin='https://grayznbuffalo.com';
function setup(t){
  const f=harness(t,{now:now.toISOString()});f.env.SESSIONS={get:async()=> '1'};
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  f.sql("INSERT INTO special_imports(id,fb_post_id,fb_created_time,image_r2_key,extracted_json,processing_status,validation_result) VALUES('test','post','2026-10-27T15:00:00Z','test.jpg',?,'staged','ok')",JSON.stringify(source.daily));
  return f;
}
async function call(f,body,{authed=true,requestOrigin=origin,type='application/json'}={}){
  const request=new Request(origin+'/admin/automation/approve',{method:'POST',headers:{'Content-Type':type,...(requestOrigin?{origin:requestOrigin}:{})},body:typeof body==='string'?body:JSON.stringify(body)});
  return POST({request,url:new URL(request.url),cookies:{get:()=>authed?{value:'a'.repeat(32)}:undefined},locals:{runtime:{env:f.env,now}}});
}
test('approval HTTP rejects anonymous, expired, cross-origin, missing-origin and unsupported requests before writes',async t=>{
  const f=setup(t);const initial=f.sql('SELECT * FROM special_slots');
  assert.equal((await call(f,{}, {authed:false})).status,401);
  f.env.SESSIONS.get=async()=>null;assert.equal((await call(f,{})).status,401);f.env.SESSIONS.get=async()=> '1';
  for(const requestOrigin of ['https://evil.example',null])assert.equal((await call(f,{}, {requestOrigin})).status,403);
  assert.equal((await call(f,{}, {type:'text/plain'})).status,415);
  assert.equal((await ALL({})).status,405);
  assert.deepEqual(f.sql('SELECT * FROM special_slots'),initial);
});
test('HTTP preview then publish is no-store, transactional and duplicate safe; malformed and oversized bodies reject',async t=>{
  const f=setup(t),m=await approvalModel(f.env,'test','2026-10-27',now),e=m.entries[0];
  const input={importId:'test',day:m.day,revision:m.collection.revision,evidenceHash:m.evidenceHash,requestId:m.requestId,confirmed:true,
    rows:[{key:e.key,content:e.content,destination:m.destinations.find(d=>d.service==='lunch').id}]};
  const before=f.sql('SELECT * FROM special_slots');
  const preview=await call(f,{mode:'preview',input});assert.equal(preview.status,200);assert.equal(preview.headers.get('cache-control'),'no-store');
  assert.equal((await preview.json()).audit.rows.length,1);assert.deepEqual(f.sql('SELECT * FROM special_slots'),before);
  const saved=await call(f,{mode:'publish',input});assert.equal(saved.status,200);
  assert.equal((await (await call(f,{mode:'publish',input})).json()).duplicate,true);
  assert.equal((await call(f,'{')).status,400);
  assert.equal((await call(f,' '.repeat(64001))).status,413);
  assert.equal(f.sql("SELECT count(*) n FROM special_import_events WHERE detail LIKE 'STAFF_APPROVAL:%'")[0].n,1);
});
