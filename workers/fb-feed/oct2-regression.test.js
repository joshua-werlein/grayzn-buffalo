import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './test-fixture.js';
import {validateEvidence,reconcilePosters} from './reconcile.js';

const oct2=()=>({day_evidence:'Friday',day_of_week:5,poster_evidence:'Friday Lunch Specials',offers:[
  {content:'1) FISH SANDWICH W/ FRIES + DRINK',evidence:'1) FISH SANDWICH W/ FRIES + DRINK',service_time:'(11 AM - 1:30 PM) $9.75'},
  {content:'2) CHEESEBURGER OR FISH SANDWICH W/ SIDE SALAD OR COLESLAW',evidence:'2) CHEESEBURGER OR FISH SANDWICH W/ SIDE SALAD OR COLESLAW',service_time:'$10.25'},
  {content:'3) CHICKEN SALAD SANDWICH W/ CUP OF COLESLAW',evidence:'3) CHICKEN SALAD SANDWICH W/ CUP OF COLESLAW',service_time:'$7.25'},
]});
// Raw content as recovered by validateEvidence (ALL CAPS preserved — evidence is never title-cased)
const expected=oct2().offers.map((o,i)=>`${o.content} ${['$9.75','$10.25','$7.25'][i]}`);
// Publication-layer output: canonicalizeSlotContent title-cases ALL CAPS content before writing to slots
const titleCased=[
  '1) Fish Sandwich w/ Fries + Drink $9.75',
  '2) Cheeseburger Or Fish Sandwich w/ Side Salad Or Coleslaw $10.25',
  '3) Chicken Salad Sandwich w/ Cup Of Coleslaw $7.25',
];
const setup=t=>{
  const f=harness(t,{now:'2026-10-02T15:00:00Z',caption:'Friday Lunch Specials',candidate:oct2()});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-09-28',week_end_date='2026-10-04' WHERE id=9000");
  Object.assign(f.state.posts[0],{created_time:'2026-10-02T14:00:00Z',updated_time:'2026-10-02T14:00:00Z'});
  return f;
};
const audit=f=>f.sql("SELECT * FROM special_import_events WHERE event_type='review' ORDER BY id");
const revision=f=>f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision;

test('Oct 2 exact extraction recovers all prices and retains lunch time without changing Friday mapping',()=>{
  const p=validateEvidence(oct2());
  assert.deepEqual(p.offers.map(o=>o.content),expected);
  assert.deepEqual(p.offers.map(o=>o.service_time),['(11 AM - 1:30 PM)','','']);
  assert.deepEqual(validateEvidence(p),p);
  assert.deepEqual(reconcilePosters([oct2()],5),[
    {day_of_week:5,service:'lunch',items:[{content:titleCased[0]}]},
    {day_of_week:5,service:'all-day',items:titleCased.slice(1).map(content=>({content}))},
  ]);
});
for (const [content,time,result] of [
  ['Fish $9.75','$9.75','Fish $9.75'],['Wings $0.99','$.99','Wings $0.99'],
  ['Wings','$.99','Wings $.99'],['Fish $10.25','$ 10.25','Fish $10.25'],
  ['Fish $10','$10.00','Fish $10'],
]) test(`price recovery does not duplicate ${content} / ${time}`,()=>{
  const p=oct2();Object.assign(p.offers[0],{content,evidence:content,service_time:time});
  assert.equal(validateEvidence(p).offers[0].content,result);
});
for (const time of ['$9.7','$9.750','$10,25','$9.75 / $10.25','$$9.75','$','USD$9.75','add $2','$.99 each','$99999999999999999999']) test(`malformed or ambiguous price fails closed: ${time}`,()=>{
  const p=oct2();p.offers[0].service_time=time;
  assert.throws(()=>validateEvidence(p),/price/);
  assert.deepEqual(reconcilePosters([p],5),[]);
});
test('conflicting content price and recovered content overflow fail closed',()=>{
  const p=oct2();p.offers[0].content='Fish $8.75';
  assert.throws(()=>validateEvidence(p),/Conflicting/);
  p.offers[0].content='A'.repeat(150);
  p.offers[0].evidence=p.offers[0].content;
  assert.throws(()=>validateEvidence(p),/150/);
});
test('Oct 2 protected All Day 1 preserves staff value, writes other two offers, and audits blocked offer',async t=>{
  const f=setup(t),id=f.slots(5,'all-day')[0].group_id;
  f.sql("UPDATE special_slots SET content='Staff correction',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",id);
  const staff=f.slots(5,'all-day')[0];
  await f.run();
  assert.equal(f.slots(5,'lunch')[0].content,titleCased[0]);
  assert.deepEqual(f.slots(5,'all-day')[0],staff);
  assert.equal(f.slots(5,'all-day')[1].content,titleCased[2]);
  assert.equal(f.imports()[0].review_status,'pending');
  assert.equal(f.imports()[0].processing_status,'staged');
  assert.equal(f.imports()[0].extracted_json,JSON.stringify(oct2()));
  assert.match(audit(f)[0].detail,/2 slot\(s\); CONFLICT: 1/);
  const blocked=JSON.parse(audit(f).at(-1).detail.split('blocked proposals: ')[1]);
  assert.deepEqual(blocked,[{day_of_week:5,service:'all-day',group_id:id,position:1,content:titleCased[1],reason:'Protected or ineligible destination slot'}]);
  const events=audit(f),rev=revision(f);
  await f.run();assert.deepEqual(audit(f),events);assert.equal(revision(f),rev);assert.equal(f.state.aiCalls,1);
});
for (const defaults of [false,true]) test(`Oct 2 all three offers reconcile normally (${defaults?'recurring defaults':'blank slots'})`,async t=>{
  const f=setup(t);
  if (defaults) f.sql("UPDATE special_slots SET content='Recurring',origin='manual',manual_locked=0 WHERE position<=2 AND group_id=?",f.slots(5,'all-day')[0].group_id);
  await f.run();
  assert.equal(f.slots(5,'lunch')[0].content,titleCased[0]);
  assert.deepEqual(f.slots(5,'all-day').slice(0,2).map(s=>s.content),titleCased.slice(1));
  assert.match(audit(f)[0].detail,/3 slot\(s\)$/);assert.equal(audit(f).length,1);
  const rev=revision(f);await f.run();assert.equal(revision(f),rev);assert.equal(audit(f).length,1);
});
test('all destinations protected still records conflict without writing specials; repeats are idempotent',async t=>{
  const f=setup(t);
  f.sql("UPDATE special_slots SET content='Staff',origin='manual',manual_locked=1 WHERE group_id IN (?,?) AND position<=2",f.slots(5,'lunch')[0].group_id,f.slots(5,'all-day')[0].group_id);
  const before=f.sql('SELECT * FROM special_slots');
  await f.run();assert.deepEqual(f.sql('SELECT * FROM special_slots'),before);
  assert.match(audit(f).at(-1).detail,/GUARDED_AUTO_CONFLICT/);
  const rev=revision(f),events=audit(f);await f.run();assert.equal(revision(f),rev);assert.deepEqual(audit(f),events);
});
test('concurrent staff edit invalidates partial writes and conflict audit together',async t=>{
  const f=setup(t),id=f.slots(5,'all-day')[0].group_id;
  f.sql("UPDATE special_slots SET content='Staff',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",id);
  const batch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{
    if(statements[0].sql.startsWith('UPDATE special_collections')) f.sql("UPDATE special_slots SET content='Racing staff',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",id);
    return batch(statements);
  };
  await f.run();assert.equal(f.slots(5,'lunch')[0].content,'');assert.equal(f.slots(5,'all-day')[1].content,'Racing staff');
  assert.equal(audit(f).length,0);assert.equal(revision(f),0);
});
test('existing parser 16 staged evidence recovers prices without another AI extraction',async t=>{
  const f=setup(t);await f.run();
  f.sql('UPDATE special_imports SET candidate_json=?',JSON.stringify(oct2()));
  for (const [service,position,index] of [['lunch',1,0],['all-day',1,1],['all-day',2,2]]) {
    f.sql('UPDATE special_slots SET content=?,last_auto_value=? WHERE group_id=? AND position=?',oct2().offers[index].content,oct2().offers[index].content,f.slots(5,service)[0].group_id,position);
  }
  await f.run();assert.equal(f.state.aiCalls,1);
  assert.equal(f.slots(5,'lunch')[0].content,titleCased[0]);
  assert.deepEqual(f.slots(5,'all-day').slice(0,2).map(s=>s.content),titleCased.slice(1));
});
test('failed partial-conflict transaction rolls back writes, revision and audit',async t=>{
  const f=setup(t);
  f.sql("UPDATE special_slots SET content='Staff',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",f.slots(5,'all-day')[0].group_id);
  const before=f.sql('SELECT * FROM special_slots'),batch=f.env.DB.batch;
  f.env.DB.batch=statements=>batch(statements[0].sql.startsWith('UPDATE special_collections') ? [...statements,{sql:'INSERT INTO missing_table VALUES(1)',args:[]}] : statements);
  await assert.rejects(()=>f.run());
  assert.deepEqual(f.sql('SELECT * FROM special_slots'),before);assert.equal(revision(f),0);assert.deepEqual(audit(f),[]);
});
