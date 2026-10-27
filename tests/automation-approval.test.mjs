import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from '../workers/fb-feed/test-fixture.js';
import {reconcileToday} from '../workers/fb-feed/guarded-auto.js';
import {reconcileDelivery} from '../workers/fb-feed/delivery.js';
import {loadTs} from './load-ts.mjs';
const {approvalModel,approvalPageContext,approveImport}=loadTs('src/lib/automation-approval.ts');
const {importOutcome}=loadTs('src/lib/automation-review.ts');
const source=JSON.parse(readFileSync('tests/fixtures/oct27-production.json','utf8'));
const now=new Date('2026-10-27T21:00:00Z'),day='2026-10-27';
function setup(t,mexican=false) {
  const raw=mexican?source.mexican:source.daily;
  const f=harness(t,{now:now.toISOString(),candidate:raw});
  f.env.SESSIONS={get:async()=> '1'};
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,parser_version,image_r2_key,candidate_json,extracted_json,processing_status,validation_result,validation_reason)
    VALUES('test','post','2026-10-27T15:00:00+0000',19,'test.jpg',?,?,'staged','ok','Uncertain extracted offer')`,mexican?null:JSON.stringify(source.dailyCandidate),JSON.stringify(raw));
  return f;
}
async function input(f,mexican=false) {
  const m=await approvalModel(f.env,'test',day,now);
  return {m,value:{importId:'test',day,revision:m.collection.revision,evidenceHash:m.evidenceHash,requestId:m.requestId,confirmed:true,
    rows:m.entries.filter(e=>!e.done).map(e=>mexican?{key:e.key,title:e.title,description:e.description,label:e.label}:{key:e.key,content:e.content,destination:m.destinations.find(d=>d.service===e.suggestedService&&d.position===e.suggestedPosition)?.id})}};
}
const all=f=>f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
const events=f=>f.sql("SELECT event_type,detail FROM special_import_events WHERE import_id='test' ORDER BY id DESC");
test('server suggests exact Tuesday destinations, retains uncertainty and previews without writes',async t=>{
  const f=setup(t);const {m,value}=await input(f);
  assert.deepEqual(m.entries.map(e=>e.suggestedService),['lunch','all-day','all-day']);
  assert.ok(m.entries[1].uncertainties.length);
  const before=all(f);const preview=await approveImport(f.env,value,now,{preview:true});
  assert.equal(preview.audit.rows.length,3);assert.deepEqual(all(f),before);assert.equal(events(f).length,0);
});
test('full daily approval locks only three destinations, preserves original evidence and rejects duplicate delivery',async t=>{
  const f=setup(t);const before=all(f);const raw=f.sql("SELECT extracted_json,candidate_json FROM special_imports WHERE id='test'");
  const {value}=await input(f);const result=await approveImport(f.env,value,now);
  assert.equal(result.complete,true);assert.equal(all(f).filter((s,i)=>s.content!==before[i].content).length,3);
  assert.equal(all(f).filter(s=>s.origin==='manual'&&s.manual_locked===1&&s.content).length,3);
  assert.deepEqual(f.sql("SELECT extracted_json,candidate_json FROM special_imports WHERE id='test'"),raw);
  const saved=all(f);assert.equal((await approveImport(f.env,value,now)).duplicate,true);assert.deepEqual(all(f),saved);assert.equal(events(f).length,1);
  assert.equal(importOutcome({},events(f)).status,'Staff Approved');
  assert.equal(JSON.parse(events(f)[0].detail.slice(15)).rows.length,3);
});
test('single-offer correction leaves sibling slots untouched and remaining uncertainty available',async t=>{
  const f=setup(t);const {value}=await input(f);value.rows=[value.rows[1]];value.rows[0].content='Bacon Cheeseburger with Side Salad, Soup or Coleslaw $10.25';
  const before=all(f);assert.equal((await approveImport(f.env,value,now)).complete,false);
  assert.equal(all(f).filter((s,i)=>s.content!==before[i].content).length,1);
  const model=await approvalModel(f.env,'test',day,now);assert.equal(model.entries.filter(e=>e.done).length,1);
  assert.equal(importOutcome({},events(f)).status,'Partially Staff Approved');
  const outcome=await reconcileToday(f.env,{sourceIds:['test'],today:day,weekday:2,inspectOnly:true});
  assert.equal(outcome.blocked.filter(b=>b.reason==='Uncertain extracted offer').length,1);
});
test('protected replacement needs explicit confirmation and records before/after ownership',async t=>{
  const f=setup(t);const g=f.slots(2,'all-day')[0].group_id;
  f.sql("UPDATE special_slots SET content='Staff burger $12',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",g);
  const {value}=await input(f);value.rows=[value.rows[1]];
  await assert.rejects(()=>approveImport(f.env,value,now),/protected/);
  assert.equal(events(f).length,0);value.rows[0].override=true;await approveImport(f.env,value,now);
  const row=JSON.parse(events(f)[0].detail.slice(15)).rows[0];assert.equal(row.previous.content,'Staff burger $12');assert.equal(row.override,true);
});
test('stale collection, edited source, superseded imports and historical dates cannot publish',async t=>{
  const f=setup(t);let {value}=await input(f);
  f.sql("UPDATE special_collections SET revision=revision+1 WHERE id='auto-week'");await assert.rejects(()=>approveImport(f.env,value,now),/changed/);
  ({value}=await input(f));f.sql("UPDATE special_imports SET extracted_json='{}' WHERE id='test'");await assert.rejects(()=>approveImport(f.env,value,now));
  assert.equal(events(f).length,0);
  await assert.rejects(()=>approvalModel(f.env,'test','2026-10-26',now),/today/);
});
test('a Worker race at the transaction boundary prevents every value and audit write',async t=>{
  const f=setup(t);const {value}=await input(f);const batch=f.env.DB.batch;
  const before=all(f);f.env.DB.batch=async statements=>{f.sql("UPDATE special_collections SET revision=revision+1 WHERE id='auto-week'");return batch(statements);};
  await assert.rejects(()=>approveImport(f.env,value,now),/changed/);assert.deepEqual(all(f),before);assert.equal(events(f).length,0);
});
test('slot changes without a revision bump are also fenced atomically',async t=>{
  const f=setup(t);const {value}=await input(f);const batch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{f.sql("UPDATE special_slots SET content='Concurrent staff correction',manual_locked=1,origin='manual' WHERE group_id=? AND position=2",f.slots(2,'all-day')[0].group_id);return batch(statements);};
  await assert.rejects(()=>approveImport(f.env,value,now),/changed/);assert.equal(events(f).length,0);assert.equal(f.slots(2,'lunch')[0].content,'');
});
test('malformed, duplicate, missing and factually changed selections fail before writes',async t=>{
  const f=setup(t);const {value}=await input(f);
  for(const mutate of [v=>v.rows=[],v=>v.rows.push(v.rows[0]),v=>v.rows[1].destination=v.rows[0].destination,v=>v.rows[0].content='Gyro $99.00',v=>v.rows[0].destination='unknown',v=>v.confirmed=false]){
    const invalid=structuredClone(value);mutate(invalid);await assert.rejects(()=>approveImport(f.env,invalid,now));
  }
  assert.equal(events(f).length,0);
});
test('Mexican complete-menu approval keeps all prices and descriptions and retains unrelated saved items',async t=>{
  const f=setup(t,true);
  f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,sort,enabled) VALUES('retained','mexican-night',-1,'custom','Other Favorites',0,1)");
  for(const p of [1,2,3,4])f.sql("INSERT INTO special_slots(group_id,position,content,origin,manual_locked) VALUES('retained',?,?, 'manual',1)",p,p===1?'Unrelated food $5':'');
  const {value}=await input(f,true);await approveImport(f.env,value,now);
  const saved=f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night'");
  assert.equal(saved.filter(s=>s.content).length,13);assert.ok(saved.some(s=>s.content==='Unrelated food $5'));
  assert.ok(saved.some(s=>s.content.startsWith('Taco Salad ... Large $9.00 | Small $8.50 | Mini $6.00\nMeat')));
  assert.ok(saved.some(s=>s.content==='Substitute Queso $0.50'));
  assert.equal(f.sql("SELECT section_source FROM special_collections WHERE id='mexican-night'")[0].section_source,'manual');
});
test('Mexican partial approval, swapped portions, omitted add-ons and duplicate foods are rejected',async t=>{
  const f=setup(t,true);const {value}=await input(f,true);
  for(const mutate of [v=>v.rows.pop(),v=>v.rows[5].title='Taco Salad Large $8.50 | Small $9.00 | Mini $6.00',v=>v.rows[0].title=v.rows[1].title]){
    const invalid=structuredClone(value);mutate(invalid);await assert.rejects(()=>approveImport(f.env,invalid,now));
  }
  assert.equal(events(f).length,0);
});
test('food approval preserves independent current-day delivery evidence',async t=>{
  const f=setup(t);f.state.now=Date.parse('2026-10-27T16:00:00Z');
  const raw=structuredClone(source.daily);raw.delivery={status:'available',evidence:'Delivery available today',date_evidence:'Tuesday',uncertainties:[]};
  f.sql("UPDATE special_imports SET extracted_json=? WHERE id='test'",JSON.stringify(raw));
  const args={sourceIds:['test'],observedAt:'2026-10-27T16:00:00Z',inspectOnly:true};
  const before=await reconcileDelivery(f.env,args);assert.equal(before.expectedActive,true);
  const {value}=await input(f);await approveImport(f.env,value,new Date(f.state.now));
  assert.equal(f.sql("SELECT review_status FROM special_imports WHERE id='test'")[0].review_status,'accepted');
  const after=await reconcileDelivery(f.env,args);assert.equal(after.expectedActive,true);
});
test('complete approval resolves a failed daily source only while its exact staff-protected values remain saved',async t=>{
  const f=setup(t);f.sql("UPDATE special_imports SET processing_status='failed',validation_result='rejected' WHERE id='test'");
  const {value}=await input(f);await approveImport(f.env,value,now);
  const args={sourceIds:['test'],today:day,weekday:2,inspectOnly:true};
  const outcome=await reconcileToday(f.env,args);assert.equal(outcome.rejectedSources.length,0);
  assert.ok(outcome.blocked.every(b=>b.reason==='Protected or ineligible destination slot'));
  f.sql("UPDATE special_slots SET content='Later correction',manual_locked=1 WHERE group_id=? AND position=1",f.slots(2,'lunch')[0].group_id);
  assert.equal((await reconcileToday(f.env,args)).rejectedSources.length,1);
});
test('staff can correct a content price to the retained source evidence amount without approving an unsupported amount',async t=>{
  const f=setup(t),raw=structuredClone(source.daily);raw.offers[0].content=raw.offers[0].content.replace('$9.75','$9.50');
  f.sql("UPDATE special_imports SET extracted_json=? WHERE id='test'",JSON.stringify(raw));
  const {value}=await input(f);value.rows=[value.rows[0]];value.rows[0].content=value.rows[0].content.replace('$9.50','$9.75');
  await approveImport(f.env,value,now);assert.equal(f.slots(2,'lunch')[0].content,'Gyro Sandwich with Beer Fries & a Drink $9.75');
});
test('thirty review panels share bounded D1 reads while POST still verifies a fresh snapshot',async t=>{
  const f=setup(t),ids=['test'];
  for(let n=1;n<30;n++){
    const id=`source-${n}`;ids.push(id);
    f.sql("INSERT INTO special_imports(id,fb_post_id,fb_created_time,image_r2_key,extracted_json,processing_status,validation_result) SELECT ?,?,fb_created_time,image_r2_key,extracted_json,processing_status,validation_result FROM special_imports WHERE id='test'",id,id);
  }
  const prepare=f.env.DB.prepare;let count=0;f.env.DB.prepare=sql=>{count++;return prepare(sql);};
  const context=await approvalPageContext(f.env,ids,day);
  for(const id of ids)assert.equal((await approvalModel(f.env,id,day,now,context)).entries.length,3);
  assert.equal(count,7,'three batched reads plus one four-query collection snapshot');
  const cached=await approvalModel(f.env,'test',day,now,context),fresh=await approvalModel(f.env,'test',day,now);
  assert.equal(cached.evidenceHash,fresh.evidenceHash);
});
