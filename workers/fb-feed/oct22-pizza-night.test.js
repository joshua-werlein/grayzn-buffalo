import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {joinPizzaSizes,analyzeDailyEvidence} from './evidence.js';
import {reconcilePosterEvidence,singleDayLunchEvidenceV2} from './reconcile.js';
import {harness} from './test-fixture.js';

// Public poster transcriptions only (stored October 22 extractions): the
// weekly-shaped THURSDAY LUNCH SPECIALS morning reading and the undated
// "TONIGHT IS PIZZA NIGHT / SPECIAL IS 5-10PM" evening reading.
const read=name=>JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`,import.meta.url),'utf8'));
const morningRaw=read('oct22-delivery.json');
const eveningRaw=read('oct22-pizza-night.json');
const morning=()=>singleDayLunchEvidenceV2(structuredClone(morningRaw));
// Stored candidate_json is the contract-2 analysis of the unmodified reading.
const eveningReading=(edit=p=>p)=>{const p=structuredClone(eveningRaw);edit(p);return p;};
const evening=(edit=p=>p)=>analyzeDailyEvidence(eveningReading(edit));
const PIZZA='12 inch 3-Topping Pizza $13.50\n16 inch 3-Topping Pizza $16';
const route=(candidates,{day=4,verified=true,existing=[]}={})=>reconcilePosterEvidence(candidates,day,existing,{
  today:['2026-10-18','2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23'][day],
  verifiedSameDaySources:new Set(verified?candidates.map((_,i)=>i):[])});
const target=(r,service)=>r.targets.find(t=>t.service===service);

test('production October 22, both processing orders: one Nightly pizza special with both printed sizes and prices',()=>{
  for(const candidates of [[morning(),evening()],[evening(),morning()]]) {
    const r=route(candidates);
    assert.deepEqual(r.unresolvedTargets,[]);
    assert.deepEqual(target(r,'nightly').items,[{position:1,content:PIZZA}]);
    assert.deepEqual(target(r,'lunch').items.map(i=>i.content),['Pulled Pork with Tots and a Drink $9.75']);
    // Fact-identical repeats: whichever post is planned first supplies the
    // wording (pre-existing rule); the evening poster prints no comma.
    assert.deepEqual(target(r,'all-day').items.map(i=>i.content.replace(',','')),
      ['BLT Wrap with Side Salad Soup or Coleslaw $10.25','Grilled Ham and Cheese with Cup of Soup or Coleslaw $7.25']);
  }
});

test('evening poster repeats published All Day automation; pizza takes the single Thursday Nightly slot',()=>{
  const existing=[{content:'BLT Wrap with Side Salad, Soup or Coleslaw $10.25'},{content:'Grilled Ham and Cheese with Cup of Soup or Coleslaw $7.25'}];
  const r=route([evening()],{existing});
  assert.deepEqual(target(r,'nightly').items,[{position:1,content:PIZZA}]);
  assert.equal(r.unresolvedTargets.length,0);
});

test('without the verified same-day timestamp the undated TONIGHT poster stays held',()=>{
  const r=route([morning(),evening()],{verified:false});
  assert.ok(!target(r,'nightly'));
  assert.ok(r.unresolvedTargets.some(t=>t.reason==='Service not established by evidence'));
});

test('printed other day, date or future reference on the TONIGHT poster is never overridden by posting time',()=>{
  for(const edit of [
    p=>{p.poster_evidence='TOMORROW IS PIZZA NIGHT SPECIAL IS 5-10PM';},
    p=>{p.poster_evidence+=' FRIDAY';},
    p=>{p.offers[0].evidence+=' 10/23';},
    p=>{p.offers[1].date_evidence='October 29';},
  ]) {
    const r=route([morning(),evening(edit)]);
    assert.ok(!target(r,'nightly'),String(edit));
    assert.ok(!r.targets.flatMap(t=>t.items).some(i=>i.content.includes('$13.50')));
  }
});

test('Tuesday and weekend TONIGHT posters receive no timestamp trust',()=>{
  for(const day of [2,6,0]) assert.ok(!target(route([evening()],{day}),'nightly'),String(day));
});

test('size variants join only when complete, certain, adjacent, same pizza, distinct sizes and same service',()=>{
  const joined=joinPizzaSizes(eveningReading());
  assert.equal(joined.offers.length,3);
  assert.equal(joined.offers[0].content,PIZZA);
  assert.equal(joined.offers[0].evidence,'12 inch 3-Topping Pizza $13.50\n16 inch 3-Topping Pizza $16');
  const untouched=[
    ['missing price',p=>{p.offers[1].content='16 inch 3-Topping Pizza';p.offers[1].evidence='16 inch 3-Topping Pizza';}],
    ['content/evidence price mismatch',p=>{p.offers[1].evidence='16 inch 3-Topping Pizza $17';}],
    ['two prices on one size',p=>{p.offers[1].content='16 inch 3-Topping Pizza $16 / $18';}],
    ['different dish',p=>{p.offers[1].content=p.offers[1].evidence='16 inch Calzone $16';}],
    ['different pizza',p=>{p.offers[1].content=p.offers[1].evidence='16 inch Supreme Pizza $16';}],
    ['same size twice',p=>{p.offers[1].content=p.offers[1].evidence='12 inch 3-Topping Pizza $16';}],
    ['no size',p=>{p.offers[1].content=p.offers[1].evidence='3-Topping Pizza $16';}],
    ['uncertain',p=>{p.offers[1].uncertainties=['price partly hidden'];}],
    ['different service',p=>{p.offers[1].service_time='11-1:30';}],
    ['date evidence',p=>{p.offers[1].date_evidence='Thursday';}],
    ['not adjacent',p=>{p.offers=[p.offers[0],p.offers[2],p.offers[1],p.offers[3]];}],
    ['daytime heading',p=>{p.poster_evidence='THURSDAY LUNCH SPECIALS';}],
  ];
  for(const [name,edit] of untouched) {
    const p=eveningReading(edit);
    assert.deepEqual(joinPizzaSizes(p),p,name);
  }
  const three=eveningReading(p=>{p.offers.splice(2,0,{...p.offers[1],content:'20" 3-Topping Pizza $21',evidence:'20" 3-Topping Pizza $21'});});
  assert.equal(joinPizzaSizes(three).offers[0].content,`${PIZZA}\n20" 3-Topping Pizza $21`);
});

test('incomplete pizza prices hold Nightly; no single size is published alone and the default stays',()=>{
  const r=route([morning(),evening(p=>{p.offers[1].content='16 inch 3-Topping Pizza';p.offers[1].evidence='16 inch 3-Topping Pizza';})]);
  assert.ok(!target(r,'nightly'));
  assert.ok(!r.targets.flatMap(t=>t.items).some(i=>/Pizza/.test(i.content)));
  assert.ok(r.unresolvedTargets.length);
});

test('a genuinely different second night offer still exceeds Thursday capacity and is held',()=>{
  const r=route([morning(),evening(p=>{p.offers[1].content=p.offers[1].evidence='Wings Basket $12';})]);
  assert.ok(!target(r,'nightly'));
});

function setup(t) {
  const f=harness(t,{now:'2026-10-22T14:26:33.245Z',candidate:structuredClone(morningRaw)});
  f.sql(readFileSync(new URL('../../migrations/0022_delivery_automation.sql',import.meta.url),'utf8'));
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-19',week_end_date='2026-10-25' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'morning',created_time:'2026-10-22T09:25:16-05:00',updated_time:'2026-10-22T09:25:16-05:00'});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  const nightly=()=>f.slots(4,'nightly')[0];
  // Production Thursday Nightly: the unlocked recurring default without prices.
  f.sql("UPDATE special_slots SET content=?,origin='manual',manual_locked=0,last_auto_value=NULL WHERE group_id=? AND position=1",
    '12” 3-Topping Pizza\n16” 3-Topping Pizza',f.slots(4,'nightly')[0].group_id);
  const addEvening=()=>{
    f.state.now=Date.parse('2026-10-22T21:28:31.200Z');f.state.candidate=structuredClone(eveningRaw);
    f.state.posts.push({...f.state.posts[0],id:'evening',created_time:'2026-10-22T16:27:13-05:00',updated_time:'2026-10-22T16:27:13-05:00'});
  };
  return {...f,nightly,addEvening};
}

test('pipeline: morning then evening publishes the priced pizza over the recurring default, idempotently',async t=>{
  const f=setup(t);await f.run();
  assert.match(f.nightly().content,/3-Topping Pizza\n16” 3-Topping Pizza$/);
  const morningCalls=f.state.aiCalls;
  f.addEvening();await f.run();
  assert.equal(f.state.aiCalls,morningCalls+1);
  const slot=f.nightly();
  assert.equal(slot.content,PIZZA);assert.equal(slot.origin,'automation');assert.equal(slot.manual_locked,0);assert.equal(slot.last_auto_value,PIZZA);
  assert.equal(f.slots(4,'nightly').filter(s=>s.content).length,1);
  assert.equal(f.slots(4,'lunch')[0].content,'Pulled Pork with Tots and a Drink $9.75');
  assert.deepEqual(f.slots(4,'all-day').filter(s=>s.content).map(s=>s.content),
    ['BLT Wrap with Side Salad, Soup or Coleslaw $10.25','Grilled Ham and Cheese with Cup of Soup or Coleslaw $7.25']);
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  const events=f.sql('SELECT count(*) n FROM special_import_events')[0].n;
  f.state.now+=30*60000;await f.run();
  assert.equal(f.state.aiCalls,morningCalls+1);
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.equal(f.sql('SELECT count(*) n FROM special_import_events')[0].n,events);
});

test('pipeline: a staff-locked Thursday Nightly edit is never overwritten',async t=>{
  const f=setup(t);
  f.sql("UPDATE special_slots SET content='Staff pizza note',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",f.nightly().group_id);
  await f.run();f.addEvening();await f.run();
  assert.equal(f.nightly().content,'Staff pizza note');
  assert.ok(f.sql("SELECT detail FROM special_import_events WHERE event_type='review'").some(e=>e.detail.includes('Protected or ineligible destination slot')));
});

test('pipeline: unchanged prior automation updates; a staff-edited automation value does not',async t=>{
  const f=setup(t);
  f.sql("UPDATE special_slots SET content='Old pizza $1',origin='automation',manual_locked=0,last_auto_value='Old pizza $1' WHERE group_id=? AND position=1",f.nightly().group_id);
  await f.run();f.addEvening();await f.run();
  assert.equal(f.nightly().content,PIZZA);
  const g=setup(t);
  g.sql("UPDATE special_slots SET content='Edited by staff',origin='automation',manual_locked=0,last_auto_value='Old pizza $1' WHERE group_id=? AND position=1",g.nightly().group_id);
  await g.run();g.addEvening();await g.run();
  assert.equal(g.nightly().content,'Edited by staff');
});
