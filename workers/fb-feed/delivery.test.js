import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import worker,{validateExtraction} from './worker.js';
import {deliveryEvidence,reconcileDelivery} from './delivery.js';
import {DELIVERY_TEXT,deliveryWindow,resolveDeliveryDisplay,readAutomaticDelivery} from '../../src/lib/delivery.js';
import {EXTRACTION_JSON_SCHEMA,RELIABLE_EXTRACTION_SCHEMA,buildReliableExtractionRequest} from './extraction.js';

const affirmative={status:'available',evidence:'DELIVERY AVAILABLE WITHIN CITY LIMITS 11-1:30',date_evidence:'Wednesday',uncertainties:[]};
function setup(t,delivery=affirmative) {
  const f=harness(t);
  f.sql(readFileSync(new URL('../../migrations/0022_delivery_automation.sql',import.meta.url),'utf8'));
  f.state.candidate.delivery=structuredClone(delivery);
  const state=()=>f.sql('SELECT * FROM delivery_automation')[0];
  return {...f,stateRow:state,display:()=>resolveDeliveryDisplay('auto',state(),new Date(f.state.now))};
}

test('affirmative current weekday activates, fixed text, duplicate queue/cron work reuses AI and leaves specials unchanged',async t=>{
  const f=setup(t);const original=structuredClone(f.state.candidate);
  const without={...original};delete without.delivery;
  assert.deepEqual(validateExtraction(JSON.stringify(original)),validateExtraction(JSON.stringify(without)));
  await f.run();assert.equal(f.display(),'available');
  assert.equal(f.slots()[0].content,'Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each');
  const before=f.stateRow(),calls=f.state.aiCalls;
  // Queue invokes the identical import path; feed refresh is independent.
  await worker.queue({messages:[{},{}]},f.env);
  assert.equal(f.state.aiCalls,calls);assert.deepEqual(f.stateRow(),before);
  assert.equal(DELIVERY_TEXT,'Delivery M–F 11 AM–1:30 PM, within Mondovi city limits.');
  assert.equal((await readAutomaticDelivery(f.env)).active,1);
});

for (const [name,value] of Object.entries({
  absent:undefined,none:{...affirmative,status:'none',evidence:''},
  ambiguous:{...affirmative,status:'ambiguous',evidence:'Delivery may be available'},
  misleading:{...affirmative,evidence:'Delivery available if a driver is available'},
  cancellation:{...affirmative,status:'cancelled',evidence:'NO DELIVERY TODAY'},
  negation:{...affirmative,evidence:'Delivery not available'},
  uncertainty:{...affirmative,uncertainties:['Unreadable notice']},
  future:{...affirmative,date_evidence:'Tomorrow'},
  oldDate:{...affirmative,date_evidence:'January 2, 2030'},
})) test(`${name} never activates delivery`,async t=>{
  const f=setup(t,value);if(name==='absent') delete f.state.candidate.delivery;
  await f.run();assert.equal(f.display(),'hidden');
});

test('staff overrides retain precedence before/after expiration; missing and invalid auto data fail closed',()=>{
  const now=new Date('2026-10-13T16:00:00Z'),w=deliveryWindow(now);
  const row={active:1,day:w.day,expires_at:w.expiresAt};
  for(const manual of ['available','unavailable','hidden']) {
    assert.equal(resolveDeliveryDisplay(manual,row,now),manual);
    assert.equal(resolveDeliveryDisplay(manual,row,new Date('2026-10-14T02:00:00Z')),manual);
  }
  for(const row of [null,{}, {active:1,day:w.day,expires_at:'bad'}]) assert.equal(resolveDeliveryDisplay('auto',row,now),'hidden');
  assert.equal(resolveDeliveryDisplay('invalid',row,now),'hidden');
});

test('3 PM rendering expires even with delayed cron; cron clears state and late retries cannot reactivate',async t=>{
  const f=setup(t);await f.run();assert.equal(f.display(),'available');
  f.state.now=Date.parse('2030-01-09T20:59:59Z');assert.equal(f.display(),'available');
  f.state.now=Date.parse('2030-01-09T21:00:00Z');assert.equal(f.display(),'hidden');
  assert.equal(f.stateRow().active,1);await f.run();assert.equal(f.stateRow().active,0);
  const calls=f.state.aiCalls;await f.run();assert.equal(f.state.aiCalls,calls);assert.equal(f.stateRow().active,0);
});

test('next-day reset and old source dates cannot enable delivery',async t=>{
  const f=setup(t);await f.run();f.state.now=Date.parse('2030-01-10T15:00:00Z');
  assert.equal(f.display(),'hidden');await f.run();assert.equal(f.stateRow().active,0);
  await reconcileDelivery(f.env,{sourceIds:f.imports().map(i=>i.id),observedAt:new Date(f.state.now).toISOString()});
  assert.equal(f.display(),'hidden');
});

test('Chicago DST cutoff, UTC midnight and weekend handling',()=>{
  for(const [before,cutoff] of [
    ['2026-03-06T20:59:59Z','2026-03-06T21:00:00Z'],
    ['2026-03-09T19:59:59Z','2026-03-09T20:00:00Z'],
    ['2026-10-30T19:59:59Z','2026-10-30T20:00:00Z'],
    ['2026-11-02T20:59:59Z','2026-11-02T21:00:00Z'],
  ]) {assert.equal(deliveryWindow(new Date(before)).open,true);assert.equal(deliveryWindow(new Date(cutoff)).open,false);assert.equal(deliveryWindow(new Date(before)).expiresAt,new Date(cutoff).toISOString());}
  assert.equal(deliveryWindow(new Date('2026-10-14T00:00:00Z')).day,'2026-10-13');
  for(const day of ['2026-03-08T16:00:00Z','2026-11-01T17:00:00Z','2026-10-17T16:00:00Z']) assert.equal(deliveryWindow(new Date(day)).open,false);
});

test('edited cancellation disables prior evidence and stale scans cannot restore it',async t=>{
  const f=setup(t);await f.run();const oldIds=f.imports().map(i=>i.id),observedAt=new Date(f.state.now).toISOString();
  f.state.now+=60000;f.state.posts[0].updated_time=new Date(f.state.now).toISOString();
  f.state.candidate.delivery={...affirmative,status:'cancelled',evidence:'No delivery today'};
  await f.run();assert.equal(f.display(),'hidden');
  await reconcileDelivery(f.env,{sourceIds:oldIds,observedAt});assert.equal(f.display(),'hidden');
});

test('no current sources clears availability; DRY_RUN never activates and OFF still expires',async t=>{
  const f=setup(t);f.env.SPECIALS_IMPORT_MODE='DRY_RUN';await f.run();assert.equal(f.display(),'hidden');
  f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';await f.run();assert.equal(f.display(),'available');
  f.state.now+=60000;f.state.posts=[];await f.run();assert.equal(f.display(),'hidden');
  f.sql("UPDATE delivery_automation SET active=1");f.env.SPECIALS_IMPORT_MODE='OFF';f.state.now=Date.parse('2030-01-09T21:00:00Z');
  await f.run();assert.equal(f.stateRow().active,0);
});

test('schemas extend only daily extraction and keep a distinguishing first key',()=>{
  for(const schema of [EXTRACTION_JSON_SCHEMA,RELIABLE_EXTRACTION_SCHEMA]) {
    assert.ok(schema.anyOf[0].properties.delivery);
    assert.equal(Object.keys(schema.anyOf[0].properties).sort()[0],'day_evidence');
    assert.equal(schema.anyOf[1].properties.delivery,undefined);assert.equal(schema.anyOf[2].properties.delivery,undefined);
  }
  assert.match(buildReliableExtractionRequest('','image').messages[1].content[0].text,/COMPLETE delivery notice/);
});

test('other weekday, weekly schedule and recurring menus cannot establish delivery',()=>{
  const w=deliveryWindow(new Date('2030-01-09T15:00:00Z'));
  for(const raw of [{day_of_week:2,day_evidence:'Tuesday',poster_evidence:''},{type:'weekly-lunch'},{type:'mexican-night'}]) {
    assert.equal(deliveryEvidence({...raw,delivery:affirmative},w),'none');
  }
});

test('contract 2 activates without extra inference; automated writes never touch staff settings',async t=>{
  const f=setup(t);
  f.sql('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)');
  f.sql("INSERT INTO settings VALUES('delivery_display','hidden')");
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  f.state.candidate.offers.forEach(o=>Object.assign(o,{service_evidence:'Wing Night',date_evidence:'',uncertainties:[]}));
  await f.run();assert.equal(f.display(),'available');assert.equal(f.state.aiCalls,1);
  assert.equal(f.sql("SELECT value FROM settings WHERE key='delivery_display'")[0].value,'hidden');
  assert.equal(resolveDeliveryDisplay('hidden',f.stateRow(),new Date(f.state.now)),'hidden');
});

test('conflicting verification withholds only delivery while preserving specials',async t=>{
  const f=setup(t);
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'always'});
  f.state.candidate.offers.forEach(o=>Object.assign(o,{service_evidence:'Wing Night',date_evidence:'',uncertainties:[]}));
  f.env.AI.run=async()=>{
    f.state.aiCalls++;
    return {response:JSON.stringify({...f.state.candidate,delivery:f.state.aiCalls===1?affirmative:{...affirmative,status:'none',evidence:''}})};
  };
  await f.run();assert.equal(f.display(),'hidden');assert.equal(f.state.aiCalls,2);
  assert.equal(f.imports()[0].validation_result,'ok');assert.match(f.slots()[0].content,/Wing Night/);
  assert.equal(JSON.parse(f.imports()[0].candidate_json).delivery_blocked,true);
  assert.equal(JSON.parse(f.imports()[0].extracted_json).delivery.status,'none');
});

test('parser mismatch and staff-reviewed sources cannot activate; manual review races fence writes',async t=>{
  const f=setup(t);await f.run();const ids=f.imports().map(i=>i.id);
  f.sql('DELETE FROM delivery_automation');f.state.now+=60000;
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  await reconcileDelivery(f.env,{sourceIds:ids,observedAt:new Date(f.state.now).toISOString()});assert.equal(f.display(),'hidden');
  delete f.env.SPECIALS_EVIDENCE_VERSION;
  f.sql("UPDATE special_imports SET review_status='edited'");f.state.now+=60000;
  await reconcileDelivery(f.env,{sourceIds:ids,observedAt:new Date(f.state.now).toISOString()});assert.equal(f.display(),'hidden');
  f.sql("UPDATE special_imports SET review_status='pending'");f.state.now+=60000;
  const prepare=f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare=query=>{
    if(query.startsWith('INSERT INTO delivery_automation')) f.sql("UPDATE special_imports SET review_status='dismissed'");
    return prepare(query);
  };
  await reconcileDelivery(f.env,{sourceIds:ids,observedAt:new Date(f.state.now).toISOString()});assert.equal(f.display(),'hidden');
});

test('AI completion crossing 3 PM cannot activate',async t=>{
  const f=setup(t);f.state.now=Date.parse('2030-01-09T20:59:59Z');
  const run=f.env.AI.run;
  f.env.AI.run=async(...args)=>{f.state.now=Date.parse('2030-01-09T21:00:01Z');return run(...args);};
  await f.run();assert.equal(f.display(),'hidden');assert.notEqual(f.stateRow()?.active,1);
});
