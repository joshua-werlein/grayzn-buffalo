import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {harness} from './test-fixture.js';
import {RELIABLE_EXTRACTION_SCHEMA} from './extraction.js';
import {reconcileDelivery} from './delivery.js';
import {deliveryWindow,resolveDeliveryDisplay} from '../../src/lib/delivery.js';

// Public poster transcription only: no production identifiers, snapshots or telemetry.
const original=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct22-delivery.json',import.meta.url),'utf8'));
const migration=readFileSync(new URL('../../migrations/0022_delivery_automation.sql',import.meta.url),'utf8');
const now='2026-10-22T14:26:33.245Z';
const daily=()=>({day_of_week:4,day_evidence:'THURSDAY',poster_evidence:'THURSDAY LUNCH SPECIALS',
  delivery:{status:'available',evidence:'DELIVERY AVAILABLE 11-1:30',date_evidence:'THURSDAY',uncertainties:[]},
  offers:original.entries.map(e=>({...e,service_time:'',service_evidence:'',date_evidence:''}))});
function setup(t,{second=daily(),budget=50,first=original,start=now}={}) {
  const f=harness(t,{now:start,candidate:structuredClone(first)});
  f.sql(migration);
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-19',week_end_date='2026-10-25' WHERE id=9000");
  f.state.posts[0].created_time='2026-10-22T09:25:16-05:00';
  f.state.posts[0].updated_time=f.state.posts[0].created_time;
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional',SPECIALS_AI_DAILY_LIMIT:budget});
  const requests=[];
  f.env.AI.run=async(model,request)=>{
    requests.push(request);f.state.aiCalls++;
    if(f.state.aiCalls===1)return {response:JSON.stringify(first)};
    if(second instanceof Error)throw second;
    return {response:typeof second==='string'?second:JSON.stringify(second)};
  };
  return {...f,requests,row:()=>f.sql('SELECT * FROM delivery_automation')[0]};
}
function food(f) {
  assert.match(f.slots(4,'lunch')[0].content,/Pulled Pork.*\$9.75/);
  assert.equal(f.slots(4,'lunch').filter(s=>s.content).length,1);
  assert.match(f.slots(4,'all-day')[0].content,/BLT Wrap.*\$10.25/);
  assert.match(f.slots(4,'all-day')[1].content,/Grilled Ham.*\$7.25/);
  assert.ok(f.sql("SELECT content FROM special_slots WHERE content LIKE 'Chicken Noodle%'").length);
}

test('October 22: delivery persistence failure records observation while food publishes; later recovery resolves without AI replay',async t=>{
  const f=setup(t);
  const alertSql=readFileSync(new URL('../../migrations/0023_facebook_alert_incidents.sql',import.meta.url),'utf8');
  for(const statement of alertSql.split(';').map(s=>s.trim()).filter(Boolean)) f.sql(statement);
  f.sql('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)');
  f.sql("INSERT OR REPLACE INTO settings(key,value) VALUES('delivery_display','auto')");
  f.env.SPECIALS_ALERT_MODE='OBSERVE';
  const db=f.env.DB;let fail=true;
  f.env.DB={...db,prepare(sql){
    if(fail && sql.startsWith('INSERT INTO delivery_automation')) return {bind(){return {async run(){throw Error('mock delivery write failure');}};}};
    return db.prepare(sql);
  }};
  await f.run();food(f);assert.equal(f.state.aiCalls,2);
  assert.equal(f.sql('SELECT state FROM facebook_alert_incidents')[0].state,'attention');
  f.state.now+=1000;fail=false;await f.run();food(f);
  assert.equal(f.row().active,1);assert.equal(f.state.aiCalls,2);
  assert.equal(f.sql('SELECT state FROM facebook_alert_incidents')[0].state,'resolved');
});
test('October 22 exact weekly response gets one daily reread; persists delivery while preserving original food and audit',async t=>{
  const f=setup(t);await f.run();food(f);
  assert.equal(f.state.aiCalls,2);
  assert.deepEqual(f.requests[1].response_format.json_schema.schema,RELIABLE_EXTRACTION_SCHEMA.anyOf[0]);
  assert.equal(f.row().active,1);
  assert.equal(resolveDeliveryDisplay('auto',f.row(),new Date(now)),'available');
  const row=f.imports()[0];assert.deepEqual(JSON.parse(row.extracted_json),original);
  assert.deepEqual(JSON.parse(row.candidate_json).delivery_recovery.delivery,daily().delivery);
  const audit=f.sql("SELECT detail FROM special_import_events WHERE event_type='validate'").map(e=>e.detail);
  assert.ok(audit.some(s=>s.includes('Daily')||s.includes('Delivery reread retained')));
  assert.equal(audit.filter(s=>s.includes('evidence-v2-response')).length,2);
  const slots=f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),state=f.row();
  await f.run();assert.equal(f.state.aiCalls,2);assert.deepEqual(f.row(),state);
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),slots);
  for(const manual of ['available','unavailable','hidden'])assert.equal(resolveDeliveryDisplay(manual,state,new Date(now)),manual);
});
for(const kind of ['none','cancelled','ambiguous','uncertain','wrong-day','tomorrow','malformed','missing','failure','wrong-shape','conditional'])
test(`delivery reread ${kind} stays hidden without losing food`,async t=>{
  let second=daily();
  if(kind==='none')second.delivery={status:'none',evidence:'',date_evidence:'',uncertainties:[]};
  if(kind==='cancelled')second.delivery={...second.delivery,status:'cancelled',evidence:'NO DELIVERY TODAY'};
  if(kind==='ambiguous')second.delivery.status='ambiguous';
  if(kind==='uncertain')second.delivery.uncertainties=['Unreadable footer'];
  if(kind==='wrong-day') {second.day_of_week=5;second.day_evidence='FRIDAY';}
  if(kind==='tomorrow')second.delivery.date_evidence='Tomorrow';
  if(kind==='malformed')second='not json';
  if(kind==='missing')delete second.delivery;
  if(kind==='failure')second=new Error('Provider unavailable');
  if(kind==='wrong-shape')second=original;
  if(kind==='conditional')second.delivery.evidence='Delivery available if driver available';
  const f=setup(t,{second});await f.run();food(f);assert.equal(f.row().active,0);
  await f.run();assert.equal(f.state.aiCalls,2);
});
test('exhausted daily AI budget preserves food, records one reservation and does not retry on cron',async t=>{
  const f=setup(t,{budget:1});await f.run();food(f);assert.equal(f.row().active,0);
  assert.equal(f.sql("SELECT * FROM special_import_events WHERE event_type='extract'").length,1);
  await f.run();assert.equal(f.state.aiCalls,1);
});
test('delivery-only reread cannot replace food with changed prices or omitted meals',async t=>{
  const second=daily();second.offers=[];
  const f=setup(t,{second});await f.run();food(f);assert.equal(f.row().active,1);
});
test('incomplete existing delivery evidence is not silently overruled by an affirmative reread',async t=>{
  const first={...original,delivery:{status:'cancelled',evidence:'NO DELIVERY'}};
  const f=setup(t,{first});await f.run();food(f);assert.equal(f.row().active,0);
  assert.equal(JSON.parse(f.imports()[0].candidate_json).delivery_blocked,true);
});
test('wrong-day source is not eligible for delivery shape recovery',async t=>{
  const first=structuredClone(original);first.poster_evidence='FRIDAY LUNCH SPECIALS';first.entries.forEach(e=>e.day_of_week=5);
  const f=setup(t,{first});await f.run();assert.ok(f.requests.every(r=>r.response_format.json_schema.schema!==RELIABLE_EXTRACTION_SCHEMA.anyOf[0]));
  assert.equal(f.row().active,0);
});
test('cutoff avoids delivery reread; recovered food still publishes',async t=>{
  const f=setup(t,{start:'2026-10-22T20:01:00Z'});await f.run();food(f);assert.equal(f.state.aiCalls,1);
  assert.equal(resolveDeliveryDisplay('auto',f.row(),new Date(f.state.now)),'hidden');
});
test('recovered delivery expires exactly at 3 PM and cannot carry into tomorrow',async t=>{
  const f=setup(t);await f.run();const row=f.row();
  assert.equal(row.expires_at,deliveryWindow(new Date(now)).expiresAt);
  assert.equal(resolveDeliveryDisplay('auto',row,new Date('2026-10-22T19:59:59Z')),'available');
  assert.equal(resolveDeliveryDisplay('auto',row,new Date('2026-10-22T20:00:00Z')),'hidden');
  assert.equal(resolveDeliveryDisplay('auto',row,new Date('2026-10-23T14:00:00Z')),'hidden');
  f.state.now=Date.parse('2026-10-22T20:00:00Z');await f.run();assert.equal(f.row().active,0);assert.equal(f.state.aiCalls,2);
});
test('real local D1 consumes persisted delivery recovery and preserves staff exclusion fence',async t=>{
  const f=setup(t);await f.run();
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  await DB.prepare(f.sql("SELECT sql FROM sqlite_master WHERE name='special_imports'")[0].sql).run();
  await DB.prepare(migration).run();
  for(const row of f.imports()) await DB.prepare(`INSERT INTO special_imports (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row)).run();
  const args={sourceIds:f.imports().map(i=>i.id),observedAt:now};
  const env={...f.env,DB}; // Keep parser 19, matching the persisted contract-2 import.
  await reconcileDelivery(env,args);assert.equal((await DB.prepare('SELECT * FROM delivery_automation').first()).active,1);
  await DB.prepare("UPDATE special_imports SET review_status='dismissed'").run();
  f.state.now+=60000;await reconcileDelivery(env,{...args,observedAt:new Date(f.state.now).toISOString()});
  assert.equal((await DB.prepare('SELECT * FROM delivery_automation').first()).active,0);
});
