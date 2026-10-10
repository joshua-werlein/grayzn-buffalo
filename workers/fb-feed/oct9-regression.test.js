import test from 'node:test';
import assert from 'node:assert/strict';
import {singleDayLunchEvidence,reconcilePosterEvidence,reconcilePosters,groupNightlyChoices} from './reconcile.js';
import {harness,offer,poster} from './test-fixture.js';

const lunch=()=>({type:'weekly-lunch',poster_evidence:'Friday Lunch Specials',service_time:'11 AM - 1:30 PM',entries:[
  {day_of_week:5,content:'1) FISH SANDWICH W/ FRIES + DRINK $9.75'},
  {day_of_week:5,content:'2) CHEESEBURGER OR FISH SANDWICH W/ SIDE SALAD, SOUP OR COLESLAW $10.25'},
  {day_of_week:5,content:'3) CHICKEN SALAD SANDWICH W/ CUP OF SOUP OR COLESLAW $7.25'},
  {day_of_week:5,content:'SOUP: FRENCH ONION OR CHILI'},
]});
const night=()=>poster(5,'Friday Night Specials 5-10pm',[
  offer('1 or 2 Piece Fish + 3 Jumbo Shrimp + Fries & Coleslaw or Side Salad $12.99/$13.99','','5-10pm'),
  offer('Chicken Stir Fry $12.99'),offer('Steak Stir Fry $13.99'),
  offer('Cheeseburger or Fish Sandwich w/Side Salad, Soup or Coleslaw $10.75'),
  offer('Chicken Salad Sandwich w/cup of Soup or Coleslaw $7.25'),
]);
const expected=[
  '1) Fish Sandwich w/ Fries + Drink $9.75',
  '2) Cheeseburger Or Fish Sandwich w/ Side Salad, Soup Or Coleslaw $10.25',
  '3) Chicken Salad Sandwich w/ Cup Of Soup Or Coleslaw $7.25',
];
const setup=(t,candidate=lunch())=>{
  const f=harness(t,{now:'2026-10-09T23:00:00Z',caption:'',candidate});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-05',week_end_date='2026-10-11' WHERE id=9000");
  Object.assign(f.state.posts[0],{created_time:'2026-10-09T14:13:58+0000',updated_time:'2026-10-09T14:13:58+0000'});
  return f;
};

test('exact October 9 weekly-shaped lunch response becomes daily evidence, preserving raw text and time',()=>{
  const input=lunch(),before=structuredClone(input),daily=singleDayLunchEvidence(input);
  assert.deepEqual(input,before);
  assert.equal(daily.day_of_week,5);
  assert.deepEqual(daily.offers.map(o=>o.content),input.entries.map(e=>e.content));
  assert.equal(daily.offers[0].service_time,'11 AM - 1:30 PM');
  const result=reconcilePosters([input],5);
  assert.equal(result.find(g=>g.service==='lunch').items[0].content,expected[0]);
  assert.deepEqual(result.find(g=>g.service==='all-day').items.map(o=>o.content),expected.slice(1));
  assert.equal(result.find(g=>g.role==='soup').items[0].content,'French Onion Or Chili');
});

test('daily lunch heading with untimed meals and Soup uses the same mapping',()=>{
  const daily=singleDayLunchEvidence(lunch());daily.offers[0].service_time='';
  assert.deepEqual(reconcilePosters([daily],5),reconcilePosters([lunch()],5));
});

test('a single-meal lunch poster is daily evidence, not a weekly schedule',()=>{
  const p=lunch();p.entries=p.entries.slice(0,1);
  assert.equal(singleDayLunchEvidence(p).offers.length,1);
  assert.equal(reconcilePosters([p],5).find(g=>g.service==='lunch').items[0].content,expected[0]);
});

test('daily-shaped lunch with a missing price holds that service and keeps unrelated valid groups',()=>{
  const p=singleDayLunchEvidence(lunch());p.offers[0].content='Fish sandwich with fries and drink';
  const result=reconcilePosterEvidence([p],5);
  assert.ok(!result.targets.some(g=>g.service==='lunch'));
  assert.ok(result.targets.some(g=>g.service==='all-day'));
  assert.ok(result.unresolvedTargets.some(t=>t.service==='lunch' && /price/.test(t.reason)));
});

for (const mutate of [p=>p.poster_evidence='Weekly Lunch Specials',p=>p.date_range='10/5-10/9',
  p=>p.entries[1].day_of_week=4,p=>p.poster_evidence='Thursday Lunch Specials'])
  test('weekly or conflicting weekday evidence is never converted to daily',()=>{
    const p=lunch();mutate(p);assert.equal(singleDayLunchEvidence(p),null);
  });

for (const content of ['Fish sandwich','Fish sandwich $9.7','Fish sandwich $9.750','Fish sandwich $9.75/$10.25',
  'Fish sandwich $9.75/10.25','Fish sandwich -$9.75','Fish sandwich − $9.75'])
  test(`new single-day recovery fails closed on missing or ambiguous price: ${content}`,()=>{
    const p=lunch();p.entries[0].content=content;
    assert.throws(()=>singleDayLunchEvidence(p),/price/);
    assert.deepEqual(reconcilePosters([p],5),[]);
  });

test('overlength content is rejected rather than truncated',()=>{
  const p=lunch();p.entries[0].content='X'.repeat(151)+' $9.75';
  assert.throws(()=>singleDayLunchEvidence(p),/Invalid offer/);
});

test('exact night extraction preserves portion amounts and groups adjacent variations without masking repeat conflict',()=>{
  const n=night(),before=structuredClone(n);
  const result=reconcilePosterEvidence([lunch(),n],5);
  assert.deepEqual(n,before);
  assert.deepEqual(result.targets.find(g=>g.service==='nightly').items.map(o=>o.content),
    [n.offers[0].content,'Chicken Stir Fry $12.99\nOR Steak Stir Fry $13.99']);
  assert.ok(result.unresolvedTargets.some(t=>t.service==='all-day' && /price conflict/.test(t.reason)));
  assert.deepEqual(result.targets.find(g=>g.service==='all-day').items.map(o=>o.content),expected.slice(1));
});

test('night-first exact five-offer evidence waits for an independent All Day pair',()=>{
  const result=reconcilePosterEvidence([night()],5);
  assert.ok(!result.targets.some(g=>g.service==='nightly'));
});

for (const contents of [
  ['Chicken Stir Fry $12.99','Steak Dinner $13.99'],
  ['Small Stir Fry $12.99','Large Stir Fry $13.99'],
  ['Chicken With Rice $12.99','Steak With Rice $13.99'],
  ['Chicken Stir Fry','Steak Stir Fry $13.99'],
  ['Chicken Stir Fry $12.99/13.99','Steak Stir Fry $13.99'],
  ['Chicken Stir Fry $12.99','Steak Stir Fry $13.99','Tofu Stir Fry $11.99'],
]) test(`ambiguous or unrelated choices never merge: ${contents.join('; ')}`,()=>{
  const items=contents.map(content=>({...offer(content),service:'unknown'}));
  assert.deepEqual(groupNightlyChoices(items),items);
});

test('conservative choice grouping generalizes beyond Friday foods and keeps changed prices',()=>{
  const items=['Lentil Curry Bowl $8.50','Chickpea Curry Bowl $9.25'].map(content=>({...offer(content),service:'unknown'}));
  assert.equal(groupNightlyChoices(items)[0].content,items.map(o=>o.content).join(' OR '));
});

test('matching dish names separated on the source poster never merge',()=>{
  const items=['Chicken Stir Fry $12.99','Steak Stir Fry $13.99'].map(content=>({...offer(content),service:'unknown'}));
  assert.deepEqual(groupNightlyChoices(items,[items[0],offer('Unrelated'),items[1]]),items);
});

for (const reverse of [false,true]) test(`validated two-offer night grouping isolates the repeated price conflict, reverse=${reverse}`,()=>{
  const n=night();
  // Explicitly confirmed grouping; do not infer it from adjacent dish similarity.
  n.offers.splice(1,2,offer('Chicken Stir Fry $12.99 OR Steak Stir Fry $13.99'));
  const result=reconcilePosterEvidence(reverse?[n,lunch()]:[lunch(),n],5);
  const nightly=result.targets.find(g=>g.service==='nightly');
  assert.deepEqual(nightly.items.map(o=>o.content),[n.offers[0].content,n.offers[1].content.replace(' OR ','\nOR ')]);
  assert.equal(result.unresolvedTargets.length,1);
  assert.match(result.unresolvedTargets[0].reason,/retained.*\$10.25/);
});

test('exact lunch pipeline replaces unlocked recurring defaults, keeps prices, and uses independent Soup',async t=>{
  const f=setup(t);
  f.sql("UPDATE special_slots SET content='Recurring value',origin='manual',manual_locked=0 WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=5) AND position=1");
  await f.run();
  assert.equal(f.imports()[0].processing_status,'staged');
  assert.equal(f.imports()[0].validation_reason,'single-day lunch evidence');
  assert.deepEqual(JSON.parse(f.imports()[0].extracted_json),lunch());
  assert.equal(f.slots(5,'lunch')[0].content,expected[0]);
  assert.deepEqual(f.slots(5,'all-day').map(s=>s.content),[...expected.slice(1),'','']);
  const soup=f.sql("SELECT s.content FROM special_slots s WHERE group_id='soup:auto-week:5' AND position=1");
  assert.equal(soup[0].content,'French Onion Or Chili');
  assert.equal(f.slots(5,'nightly')[0].content,'Recurring value');
});

test('locked staff lunch correction survives while All Day and Soup publish',async t=>{
  const f=setup(t);
  f.sql('UPDATE special_slots SET content=?,origin=?,manual_locked=1 WHERE group_id=? AND position=1','Staff pick $8','manual',f.slots(5,'lunch')[0].group_id);
  await f.run();assert.equal(f.slots(5,'lunch')[0].content,'Staff pick $8');
  assert.equal(f.slots(5,'all-day')[0].content,expected[1]);
  assert.match(f.sql("SELECT detail FROM special_import_events WHERE event_type='review' ORDER BY id DESC")[0].detail,/Protected or ineligible/);
});

for (const nightFirst of [false,true]) test(`exact October 9 pipeline is deterministic when ${nightFirst?'night':'lunch'} arrives first`,async t=>{
  const f=setup(t,nightFirst?night():lunch());
  const dayTime='2026-10-09T14:13:58+0000',nightTime='2026-10-09T21:26:34+0000';
  Object.assign(f.state.posts[0],{created_time:nightFirst?nightTime:dayTime,updated_time:nightFirst?nightTime:dayTime});
  await f.run();
  if (nightFirst) assert.ok(f.slots(5,'nightly').every(s=>s.content===''));
  f.state.posts.push({...f.state.posts[0],id:'second',created_time:nightFirst?dayTime:nightTime,updated_time:nightFirst?dayTime:nightTime});
  f.state.candidate=nightFirst?lunch():night();await f.run();
  assert.equal(f.slots(5,'lunch')[0].content,expected[0]);
  assert.deepEqual(f.slots(5,'all-day').map(s=>s.content),[...expected.slice(1),'','']);
  assert.deepEqual(f.slots(5,'nightly').map(s=>s.content),[night().offers[0].content,'Chicken Stir Fry $12.99\nOR Steak Stir Fry $13.99','','']);
  const events=f.sql("SELECT * FROM special_import_events WHERE event_type='review'");
  assert.match(events.at(-1).detail,/Repeated All Day price conflict/);
  assert.match(events.at(-1).detail,/\$10.75/);
  assert.match(events.at(-1).detail,/retained.*\$10.25/);
  assert.equal(f.state.aiCalls,2);
  const revision=f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision;
  await f.run();assert.equal(f.state.aiCalls,2);
  assert.equal(f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision,revision);
  assert.deepEqual(f.sql("SELECT * FROM special_import_events WHERE event_type='review'"),events);
  assert.equal(f.sql("SELECT service_time FROM special_groups WHERE collection_id='auto-week' AND day_of_week=5 AND service='nightly'")[0].service_time,'5–10 PM');
});

for (const content of ['Fish and shrimp','Fish and shrimp $12.9','Fish and shrimp $12.99/13.99'])
  test(`missing or malformed fish prices block only Nightly: ${content}`,()=>{
    const n=night();n.offers[0].content=content;
    const result=reconcilePosterEvidence([lunch(),n],5);
    assert.ok(!result.targets.some(g=>g.service==='nightly'));
    assert.ok(result.targets.some(g=>g.service==='lunch'));
    assert.ok(result.unresolvedTargets.some(t=>/nightly prices/.test(t.reason)));
  });

test('choice grouping cannot silently exceed the ordinary slot limit',()=>{
  const base='Long '.repeat(14)+'Dish';
  const items=[`Chicken ${base} $12.99`,`Steak ${base} $13.99`].map(content=>({...offer(content),service:'unknown'}));
  assert.ok(items.every(o=>o.content.length<=150));
  assert.deepEqual(groupNightlyChoices(items),items);
});

test('mistaken dedicated type cannot hide conflicting daily offers',()=>{
  const p={...lunch(),offers:[offer('Contradictory data')]};
  assert.equal(singleDayLunchEvidence(p),null);
});

test('a failed daily response cannot publish merely because its raw type said weekly-lunch',async t=>{
  const f=setup(t);await f.run();
  f.sql("UPDATE special_imports SET processing_status='failed',validation_result='rejected',validation_reason='Operator review required',candidate_json=NULL");
  f.sql("UPDATE special_slots SET content='',origin='legacy',last_auto_value=NULL WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id='auto-week')");
  await f.run();
  assert.ok(f.slots(5,'lunch').every(s=>s.content===''));
  assert.ok(f.slots(5,'all-day').every(s=>s.content===''));
  assert.match(f.sql("SELECT detail FROM special_import_events WHERE event_type='review' ORDER BY id DESC")[0].detail,/Operator review required/);
});
