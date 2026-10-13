// Daily and night posts discovered in the SAME cron: verified All Day offers on
// one post identify identical repeats on the other before publication. Similar
// offers whose price or description differs are never treated as the same.
// The night poster is the REAL Oct 5 contract-2 reading; day posters are mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reconcilePosterEvidence} from './reconcile.js';
import {harness} from './test-fixture.js';

const NIGHT=JSON.parse(readFileSync(new URL('../../tests/fixtures/contract2-eval/oct05-mon-night.json',import.meta.url),'utf8')).first_reading;
const BLT='BLT on Texas Toast w/ Side Salad or Coleslaw - $10.25',CHICKEN='Chicken Salad Sandwich w/ Cup of Coleslaw - $7.25';
const offer=(content,service_evidence='')=>({content,evidence:content,service_time:'',service_evidence,date_evidence:'',uncertainties:[]});
// Monday day poster with labeled services (layout-independent).
const day=(allDay)=>({day_of_week:1,day_evidence:'Monday',poster_evidence:'MONDAY SPECIALS',
  offers:[offer('Caesar Salad and a Drink - $9.75','Lunch 11-1:30'),...allDay.map(c=>offer(c,'All Day'))]});
const plan=(candidates,existingAllDay=[])=>reconcilePosterEvidence(candidates.map(c=>({...c,evidence_version:2})),1,existingAllDay,{today:'2026-10-05'});
const services=r=>Object.fromEntries(r.targets.map(t=>[t.service,t.items.map(i=>i.content)]));

test('same cron, identical repeats: night poster publishes Nightly; All Day agrees across both posts',()=>{
  const r=plan([day([BLT,CHICKEN]),NIGHT]);
  assert.deepEqual(services(r),{lunch:['Caesar Salad and a Drink - $9.75'],'all-day':[BLT,CHICKEN],
    nightly:['2 Burgers and 1 Order of Fries - $14','Half Rack Ribs with Mac n Cheese & Coleslaw - $18.75']});
});
test('same cron, night poster processed FIRST: repeats are still recognized from the day poster',()=>{
  assert.deepEqual(Object.keys(services(plan([NIGHT,day([BLT,CHICKEN])]))).sort(),['all-day','lunch','nightly']);
});
test('same cron, the real Oct 5 wording differs ("Cup of Coleslaw" vs "Cup of Soup or Coleslaw"): never merged',()=>{
  const r=plan([day([BLT,'Chicken Salad Sandwich w/ Cup of Soup or Coleslaw - $7.25']),NIGHT]);
  // The night poster's layout cannot be identified once the known All Day pair fails
  // to match, so its meals stay unresolved. Its Chicken Salad Sandwich is the same
  // dish with different sides: it could contradict the day poster's All Day offer,
  // so All Day is held too. The independently verified Lunch still publishes.
  assert.deepEqual(services(r),{lunch:['Caesar Salad and a Drink - $9.75']});
  assert.ok(r.unresolvedTargets.some(u=>u.service==='all-day' && u.reason==='Unresolved offer could contradict this offer'));
});
test('same cron, same dish at another price on the night poster: not a repeat; Nightly held',()=>{
  const r=plan([day(['BLT on Texas Toast w/ Side Salad or Coleslaw - $11.25',CHICKEN]),NIGHT]);
  assert.ok(!r.targets.some(t=>t.service==='nightly'));
});
test('two posts labeling DIFFERENT All Day pairs conflict: All Day held, other services publish',()=>{
  const night={...NIGHT,offers:NIGHT.offers.map((o,i)=>({...o,service_evidence:i<2?'5-10 PM':'All Day'}))};
  const r=plan([day(['Fish Fry - $12.00','Reuben - $11.00']),night]);
  assert.ok(!r.targets.some(t=>t.service==='all-day'));
  assert.ok(r.unresolvedTargets.some(u=>u.reason==='Conflicting source offers'));
  assert.deepEqual(services(r).nightly,['2 Burgers and 1 Order of Fries - $14','Half Rack Ribs with Mac n Cheese & Coleslaw - $18.75']);
});
test('earlier cron: repeats recognized from already-published automation with identical text',()=>{
  const r=plan([NIGHT],[{content:BLT},{content:CHICKEN}]);
  assert.deepEqual(services(r).nightly,['2 Burgers and 1 Order of Fries - $14','Half Rack Ribs with Mac n Cheese & Coleslaw - $18.75']);
  assert.deepEqual(services(r)['all-day'],[BLT,CHICKEN]);
});

test('integration: day and night posts found in one cron publish atomically; a staff lock is kept; reruns are idempotent',async t=>{
  const f=harness(t,{now:'2026-10-05T23:30:00Z'});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-05',week_end_date='2026-10-11' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'day',message:'CAPTION-7F3-DAY',created_time:'2026-10-05T14:00:00Z',updated_time:'2026-10-05T14:00:00Z'});
  f.state.posts.push({...f.state.posts[0],id:'night',message:'CAPTION-7F3-NIGHT',created_time:'2026-10-05T22:00:00Z',updated_time:'2026-10-05T22:00:00Z'});
  const responses={'CAPTION-7F3-DAY':day([BLT,CHICKEN]),'CAPTION-7F3-NIGHT':NIGHT};
  f.env.AI.run=async(_m,request)=>{f.state.aiCalls++;const text=request.messages[1].content[0].text;
    return {response:JSON.stringify(responses[Object.keys(responses).find(k=>text.includes(k))])};};
  const nightly=f.slots(1,'nightly')[0].group_id;
  f.sql("UPDATE special_slots SET content='Staff Steak $22',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",nightly);
  await f.run();
  assert.equal(f.slots(1,'lunch')[0].content,'Caesar Salad and a Drink - $9.75');
  assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>s.content),[BLT,CHICKEN]);
  const [one,two]=f.slots(1,'nightly');
  assert.deepEqual([one.content,one.origin],['2 Burgers and 1 Order of Fries - $14','automation']);
  assert.deepEqual([two.content,two.manual_locked],['Staff Steak $22',1]);
  const revision=()=>f.sql("SELECT revision FROM special_collections WHERE id='auto-week'");
  const before=revision();await f.run();await f.run();
  assert.deepEqual(revision(),before);
  assert.equal(f.state.aiCalls,2);
});
test('same cron, unidentifiable night layout repeating ONE All Day offer: the identical repeat does not contest the day poster',()=>{
  // Three night meals then one repeat: the night layout cannot be identified, and
  // its unresolved meals precede the repeat while All Day still has a free slot.
  const night={...NIGHT,offers:[NIGHT.offers[0],NIGHT.offers[1],
    {...NIGHT.offers[1],content:'Steak & Shrimp - $22',evidence:'Steak & Shrimp - $22'},NIGHT.offers[2]]};
  const r=plan([day([BLT,CHICKEN]),night]);
  assert.deepEqual(services(r),{lunch:['Caesar Salad and a Drink - $9.75'],'all-day':[BLT,CHICKEN]});
});
