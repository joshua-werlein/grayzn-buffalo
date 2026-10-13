// Same-day switching between evidence contracts (deploy and rollback). Rows of
// one contract must never supersede, block or be published by the other.
// All AI responses are mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './test-fixture.js';

// Valid for BOTH contracts: legacy needs a complete explicit All Day pair;
// contract 2 additionally accepts the per-offer evidence fields.
const both={day_of_week:1,day_evidence:'Monday',poster_evidence:'Monday Specials',offers:[
  {content:'Burger $10',service_time:'All Day',evidence:'Burger $10',service_evidence:'All Day',date_evidence:'',uncertainties:[]},
  {content:'Salad $9',service_time:'All Day',evidence:'Salad $9',service_evidence:'All Day',date_evidence:'',uncertainties:[]}]};
function setup(t) {
  const f=harness(t,{now:'2026-10-12T15:00:00Z',candidate:both});
  Object.assign(f.state.posts[0],{created_time:'2026-10-12T14:00:00Z',updated_time:'2026-10-12T14:00:00Z'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-12',week_end_date='2026-10-18' WHERE id=9000");
  const contract=(version,mode)=>{
    f.env.SPECIALS_IMPORT_MODE=mode;
    if(version===2) Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
    else {delete f.env.SPECIALS_EVIDENCE_VERSION;delete f.env.SPECIALS_VERIFICATION_STRATEGY;}
  };
  const advance=minutes=>{f.state.now+=minutes*60*1000;};
  return {...f,contract,advance};
}
const allDay=f=>f.slots(1,'all-day').slice(0,2).map(s=>s.content);

test('rollback 2 → 1 the same day: the older contract-1 row still publishes',async t=>{
  const f=setup(t);
  f.contract(1,'DRY_RUN');await f.run();          // contract-1 row staged first
  f.advance(30);f.contract(2,'DRY_RUN');await f.run(); // contract-2 row of the same post, newer rowid
  f.advance(30);f.contract(1,'GUARDED_AUTO');await f.run();
  assert.deepEqual(allDay(f),['Burger $10','Salad $9']);
});
test('deploy 1 → 2 the same day: the newer contract publishes from its own row',async t=>{
  const f=setup(t);
  f.contract(2,'DRY_RUN');await f.run();
  f.advance(30);f.contract(1,'DRY_RUN');await f.run();
  f.advance(30);f.contract(2,'GUARDED_AUTO');await f.run();
  assert.deepEqual(allDay(f),['Burger $10','Salad $9']);
});
test('each contract reuses its own staged evidence: switching back and forth makes no extra AI calls',async t=>{
  const f=setup(t);
  f.contract(1,'GUARDED_AUTO');await f.run();
  f.advance(30);f.contract(2,'GUARDED_AUTO');await f.run();
  const calls=f.state.aiCalls;
  for(const version of [1,2,1,2]) {f.advance(30);f.contract(version,'GUARDED_AUTO');await f.run();}
  assert.equal(f.state.aiCalls,calls);
  assert.deepEqual(allDay(f),['Burger $10','Salad $9']);
  assert.deepEqual(f.imports().map(i=>i.processing_status),['staged','staged']);
});
