import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {deliveryEvidence,reconcileDelivery} from './delivery.js';
import {deliveryAlertObservation} from './alert-policy.js';
import {deliveryWindow,resolveDeliveryDisplay} from '../../src/lib/delivery.js';

// Public poster transcription only (the stored October 23 extraction): the
// DAILY SPECIALS template prints DELIVERY AVAILABLE 11-1:30 and no weekday.
const original=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct23-delivery.json',import.meta.url),'utf8'));
const migration=readFileSync(new URL('../../migrations/0022_delivery_automation.sql',import.meta.url),'utf8');
const now='2026-10-23T14:26:05.441Z';
const friday=deliveryWindow(new Date(now));
const poster=(edit=p=>p)=>{const p=structuredClone(original);edit(p);return p;};
function setup(t,{first=original,start=now,created='2026-10-23T09:24:45-05:00'}={}) {
  const f=harness(t,{now:start,candidate:structuredClone(first)});
  f.sql(migration);
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-19',week_end_date='2026-10-25' WHERE id=9000");
  Object.assign(f.state.posts[0],{created_time:created,updated_time:created});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  return {...f,row:()=>f.sql('SELECT * FROM delivery_automation')[0]};
}
function food(f) {
  assert.deepEqual(f.slots(5,'lunch').filter(s=>s.content).map(s=>s.content),['Fish Sandwich w/ Fries + Drink $9.75']);
  assert.deepEqual(f.slots(5,'all-day').filter(s=>s.content).map(s=>s.content),
    ['Cheeseburger or Fish Sandwich w/ Side Salad, Soup or Coleslaw $10.25','Grilled Ham and Cheese w/ Cup of Soup or Coleslaw $7.25']);
  assert.ok(f.sql("SELECT content FROM special_slots WHERE content='Chicken Noodle or Chili'").length);
}

test('October 23 production poster: undated DAILY SPECIALS delivery publishes; food unchanged; one AI call; idempotent',async t=>{
  const f=setup(t);await f.run();food(f);
  assert.equal(f.state.aiCalls,1);
  const row=f.row();
  assert.equal(row.day,'2026-10-23');assert.equal(row.active,1);assert.equal(row.expires_at,friday.expiresAt);
  assert.equal(resolveDeliveryDisplay('auto',row,new Date(now)),'available');
  assert.deepEqual(JSON.parse(f.imports()[0].extracted_json),original);
  const slots=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  f.state.now+=30*60000;await f.run();
  assert.equal(f.state.aiCalls,1);assert.equal(f.row().active,1);
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),slots);
});

test('timestamp trust is required: the untrusted reading stays hidden exactly as before',()=>{
  assert.equal(deliveryEvidence(original,friday),'none');
  assert.equal(deliveryEvidence(original,friday,{trustedSameDay:true}),'available');
});

test('printed weekday, calendar date or future reference anywhere on the poster is never overridden by posting time',()=>{
  const cases=[
    p=>{p.day_evidence='THURSDAY';},
    p=>{p.day_of_week=4;},
    p=>{p.poster_evidence='THURSDAY SPECIALS';},
    p=>{p.delivery.date_evidence='10/22';},
    p=>{p.delivery.date_evidence='10/30';},
    p=>{p.delivery.date_evidence='Tomorrow';},
    p=>{p.delivery.evidence='DELIVERY AVAILABLE TOMORROW 11-1:30';},
    p=>{p.offers[1].evidence+=' (THURSDAY ONLY)';},
    p=>{p.offers[0].date_evidence='October 30';},
    p=>{p.poster_evidence='DAILY SPECIALS NEXT WEEK';},
  ];
  for(const edit of cases) assert.equal(deliveryEvidence(poster(edit),friday,{trustedSameDay:true}),'none',String(edit));
  // A matching printed weekday/date remains accepted through the existing explicit path.
  assert.equal(deliveryEvidence(poster(p=>{p.day_of_week=5;p.day_evidence='FRIDAY';}),friday),'available');
  assert.equal(deliveryEvidence(poster(p=>{p.delivery.date_evidence='10/23';}),friday,{trustedSameDay:true}),'available');
});

test('only the exact DAILY SPECIALS daily template is eligible for timestamp trust',()=>{
  for(const heading of ['DAILY LUNCH SPECIALS','TONIGHT IS PIZZA NIGHT','SPECIALS','WEEKLY LUNCH SPECIALS','DAILY SPECIALS 5-10PM'])
    assert.equal(deliveryEvidence(poster(p=>{p.poster_evidence=heading;}),friday,{trustedSameDay:true}),'none',heading);
  assert.equal(deliveryEvidence({...poster(),type:'weekly-lunch'},friday,{trustedSameDay:true}),'none');
  assert.equal(deliveryEvidence(poster(p=>{delete p.offers;}),friday,{trustedSameDay:true}),'none');
});

test('weekend windows never use the undated template',()=>{
  const saturday=deliveryWindow(new Date('2026-10-24T15:00:00Z'));
  assert.equal(saturday.weekday,6);
  assert.equal(deliveryEvidence(original,saturday,{trustedSameDay:true}),'none');
  assert.equal(deliveryEvidence(original,deliveryWindow(new Date('2026-10-25T15:00:00Z')),{trustedSameDay:true}),'none');
});

test('cancellation, conditional wording and uncertainty still fail closed under timestamp trust',()=>{
  const cancel=poster(p=>{p.delivery={...p.delivery,status:'cancelled',evidence:'NO DELIVERY TODAY'};});
  assert.equal(deliveryEvidence(cancel,friday,{trustedSameDay:true}),'cancelled');
  assert.equal(deliveryEvidence(poster(p=>{p.delivery.evidence='DELIVERY AVAILABLE IF DRIVER AVAILABLE';}),friday,{trustedSameDay:true}),'ambiguous');
  assert.equal(deliveryEvidence(poster(p=>{p.delivery.uncertainties=['Footer partly hidden'];}),friday,{trustedSameDay:true}),'ambiguous');
  assert.equal(deliveryEvidence(poster(p=>{p.delivery.status='ambiguous';}),friday,{trustedSameDay:true}),'ambiguous');
  assert.equal(deliveryEvidence(poster(p=>{p.delivery={status:'none',evidence:'',date_evidence:'',uncertainties:[]};}),friday,{trustedSameDay:true}),'none');
});

test('pipeline: cancellation on the same template hides delivery and keeps food',async t=>{
  const f=setup(t,{first:poster(p=>{p.delivery={...p.delivery,status:'cancelled',evidence:'NO DELIVERY TODAY'};})});
  await f.run();food(f);assert.equal(f.row().active,0);
});

test('pipeline: printed other weekday keeps delivery hidden despite a Friday timestamp',async t=>{
  const f=setup(t,{first:poster(p=>{p.delivery.date_evidence='10/30';})});
  await f.run();assert.equal(f.row().active,0);
});

test('a future Facebook timestamp grants no trust',async t=>{
  const f=setup(t);await f.run();
  f.sql("UPDATE special_imports SET fb_created_time='2026-10-23T18:00:00+0000'");
  f.state.now+=60000;
  const result=await reconcileDelivery(f.env,{sourceIds:f.imports().map(i=>i.id),observedAt:new Date(f.state.now).toISOString()});
  assert.equal(result.status,'hidden');assert.equal(f.row().active,0);
});

test('staff overrides still win over the automatic notice and are never written',async t=>{
  const f=setup(t);
  f.sql('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)');
  f.sql("INSERT OR REPLACE INTO settings(key,value) VALUES('delivery_display','hidden')");
  await f.run();const row=f.row();assert.equal(row.active,1);
  for(const manual of ['available','unavailable','hidden']) assert.equal(resolveDeliveryDisplay(manual,row,new Date(now)),manual);
  assert.equal(f.sql("SELECT value FROM settings WHERE key='delivery_display'")[0].value,'hidden');
});

test('expires exactly at 1:30 PM Chicago and never carries into Saturday',async t=>{
  const f=setup(t);await f.run();const row=f.row();
  assert.equal(resolveDeliveryDisplay('auto',row,new Date('2026-10-23T18:29:59Z')),'available');
  assert.equal(resolveDeliveryDisplay('auto',row,new Date('2026-10-23T18:30:00Z')),'hidden');
  assert.equal(resolveDeliveryDisplay('auto',row,new Date('2026-10-24T15:00:00Z')),'hidden');
  f.state.now=Date.parse('2026-10-23T18:30:00Z');await f.run();
  assert.equal(f.row().active,0);assert.equal(f.state.aiCalls,1);
});

test('poster processed after the 1:30 PM cutoff publishes food but no delivery',async t=>{
  const f=setup(t,{start:'2026-10-23T18:31:00Z'});await f.run();food(f);
  assert.equal(resolveDeliveryDisplay('auto',f.row()??null,new Date(f.state.now)),'hidden');
});

test('alert compatibility: October 23 now reports published/resolved instead of an uneventful hidden result',async t=>{
  const f=setup(t);await f.run();
  f.state.now+=60000;
  const args={sourceIds:f.imports().map(i=>i.id),observedAt:new Date(f.state.now).toISOString()};
  const inspected=await reconcileDelivery(f.env,{...args,inspectOnly:true});
  assert.equal(inspected.status,'expected');
  assert.deepEqual(inspected.sourceOutcomes.map(s=>s.status),['available']);
  const result=await reconcileDelivery(f.env,args);
  assert.equal(result.status,'published');
  assert.equal(deliveryAlertObservation(result).state,'resolved');
});
