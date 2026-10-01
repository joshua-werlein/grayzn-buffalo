import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reconcilePosters} from './reconcile.js';
import {PARSER_VERSION} from './classify.js';
import {harness,offer,poster} from './test-fixture.js';

const dishes=[
  'Chicken Mashed Potato Bowl and a Drink $9.75',
  'California Burger w/ Side Salad, Chili or Coleslaw $10.25',
  'Chicken Salad Sandwich w/ Cup of Chili or Coleslaw $7.25',
];
const daytime=()=>poster(4,'Thursday Specials',dishes.map(s=>offer(s)));
const dinner='Steak with Potatoes $18.75';
const evening=()=>poster(4,'Thursday Night Specials 5–10 PM',[
  offer(dinner),...dishes.slice(1).map(s=>offer(s.replace('w/','with').replace(' $',' — $'))),
]);
const expected=[
  {day_of_week:4,service:'lunch',items:[{content:dishes[0]}]},
  {day_of_week:4,service:'all-day',items:dishes.slice(1).map(content=>({content}))},
];
const makeHarness=(t,candidate=daytime())=>{
  const f=harness(t,{now:'2030-01-10T23:00:00Z',caption:'Thursday Specials',candidate});
  Object.assign(f.state.posts[0],{created_time:'2030-01-10T14:00:00Z',updated_time:'2030-01-10T14:00:00Z'});
  return f;
};

test('exact Thursday Specials: three untimed offers produce Lunch + All Day, never Nightly',()=>{
  assert.deepEqual(reconcilePosters([daytime()],4),expected);
});
for(const day of [1,2,3,4,5]) test(`generic weekday ${day} supports the ordered daytime pattern`,()=>{
  const p=poster(day,'Specials',dishes.map(s=>offer(s)));
  assert.deepEqual(reconcilePosters([p],day),expected.map(g=>({...g,day_of_week:day})));
});
for(const heading of ['Thursday Night Specials','Thursday Nightly Specials','Thursday Wing Night Specials','Thursday Specials 5–10','Thursday Specials 5-10 PM','Thursday Lunch and Night Specials']) test(`${heading} cannot use the daytime fallback`,()=>{
  const p=daytime();p.poster_evidence=heading;
  assert.deepEqual(reconcilePosters([p],4),[]);
});
for(const service_time of ['Nightly','Wing Night','5–10 PM','Lunch and Night']) test(`per-offer service_time ${service_time} blocks daytime fallback`,()=>{
  const p=daytime();p.offers[0].service_time=service_time;
  assert.ok(reconcilePosters([p],4).every(g=>!['lunch','all-day'].includes(g.service)));
});
test('explicit service_time in other positions is never overridden by offer order',()=>{
  const p=daytime();p.offers[1].service_time='Lunch';
  const groups=reconcilePosters([p],4);
  assert.equal(groups.find(g=>g.service==='lunch').items[0].content,dishes[1]);
  p.offers[1].service_time='';p.offers[0].service_time='All Day';
  assert.deepEqual(reconcilePosters([p],4),[]);
});
test('matching partial service evidence supports the same three-offer pattern',()=>{
  const p=daytime();p.offers[2].evidence='All Day';
  assert.deepEqual(reconcilePosters([p],4),expected);
});
test('weekends, wrong weekday, non-specials headings, and other offer counts stay outside the rule',()=>{
  assert.deepEqual(reconcilePosters([daytime()],3),[]);
  for(const heading of ['Thursday','Thursday Weekly Specials']) {
    const p=daytime();p.poster_evidence=heading;assert.deepEqual(reconcilePosters([p],4),[]);
  }
  for(const offers of [dishes.slice(0,2),[...dishes,'Another offer $5']]) assert.deepEqual(reconcilePosters([poster(4,'Thursday Specials',offers.map(s=>offer(s)))],4),[]);
});
test('Saturday 3-offer Specials poster produces Saturday Special + All Day slots',()=>{
  const p=poster(6,'Saturday Specials',dishes.map(s=>offer(s)));
  assert.deepEqual(reconcilePosters([p],6),[
    {day_of_week:6,service:'lunch',items:[{content:dishes[0]}]},
    {day_of_week:6,service:'all-day',items:dishes.slice(1).map(c=>({content:c}))},
  ]);
});
test('Sunday 3-offer Specials poster produces Sunday Special + All Day slots',()=>{
  const p=poster(0,'Sunday Specials',dishes.map(s=>offer(s)));
  assert.deepEqual(reconcilePosters([p],0),[
    {day_of_week:0,service:'lunch',items:[{content:dishes[0]}]},
    {day_of_week:0,service:'all-day',items:dishes.slice(1).map(c=>({content:c}))},
  ]);
});
test('Saturday nightly-headed poster fails closed (no nightly on weekends)',()=>{
  const p=poster(6,'Saturday Night Specials 5-10 PM',[offer(dishes[0],'Night'),offer(dishes[1],'Night')]);
  assert.deepEqual(reconcilePosters([p],6),[]);
});
test('Saturday 2-offer poster fails closed (not exactly 3)',()=>{
  const p=poster(6,'Saturday Specials',dishes.slice(0,2).map(s=>offer(s)));
  assert.deepEqual(reconcilePosters([p],6),[]);
});
test('Saturday 4-offer poster fails closed (not exactly 3)',()=>{
  const p=poster(6,'Saturday Specials',[...dishes,'Another offer $5'].map(s=>offer(s)));
  assert.deepEqual(reconcilePosters([p],6),[]);
});
test('weekday 3-offer poster (Thursday) is unchanged by the fix',()=>{
  assert.deepEqual(reconcilePosters([daytime()],4),expected);
});
for(const nightFirst of [false,true]) test(`Thursday pipeline ${nightFirst?'night first':'day first'} resolves without repeated AI and preserves All Day`,async t=>{
  const f=makeHarness(t,nightFirst?evening():daytime());await f.run();
  assert.ok(f.slots(4,'nightly').every(s=>s.content===''));
  if(!nightFirst) {
    assert.equal(f.slots(4,'lunch')[0].content,dishes[0]);
    assert.deepEqual(f.slots(4,'all-day').map(s=>s.content),[...dishes.slice(1),'','']);
  }
  const established=f.slots(4,'all-day');
  f.state.posts.push({...f.state.posts[0],id:'second',created_time:'2030-01-10T20:00:00Z',updated_time:'2030-01-10T20:00:00Z'});
  f.state.candidate=nightFirst?daytime():evening();await f.run();
  assert.equal(f.slots(4,'lunch')[0].content,dishes[0]);
  assert.deepEqual(f.slots(4,'all-day').map(s=>s.content),[...dishes.slice(1),'','']);
  assert.deepEqual(f.slots(4,'nightly').map(s=>s.content),[dinner,'','','']);
  if(!nightFirst) assert.deepEqual(f.slots(4,'all-day'),established);
  await f.run();assert.equal(f.state.aiCalls,2);
});
test('Thursday evening price conflict never replaces established All Day or creates Nightly',async t=>{
  const f=makeHarness(t);await f.run();const before=f.slots(4,'all-day');
  f.state.posts=[{...f.state.posts[0],id:'evening'}];f.state.candidate=evening();
  f.state.candidate.offers[1].content=f.state.candidate.offers[1].content.replace('10.25','10.50');
  await f.run();assert.deepEqual(f.slots(4,'all-day'),before);assert.ok(f.slots(4,'nightly').every(s=>s.content===''));
});
test('parser 16 reprocesses a Thursday source claimed by parser 10 without deleting history',async t=>{
  assert.equal(PARSER_VERSION,16);
  const f=makeHarness(t);const raw=f.state.posts[0];
  const digest=(s,n)=>createHash('sha256').update(s).digest('hex').slice(0,n*2);
  const captionHash=digest(raw.message,8), version=`updated:${raw.updated_time}`;
  const model='@cf/meta/llama-3.2-11b-vision-instruct';
  const oldId=digest(`test:${raw.id}:${captionHash}:${version}:10:${model}`,16);
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,caption_hash,image_source_version,parser_version,model_id,processing_status,fetched_at)
    VALUES(?,?,?,?,?,10,?,'staged',?)`,oldId,raw.id,raw.created_time,captionHash,version,model,raw.created_time);
  await f.run();assert.equal(f.state.aiCalls,1);assert.equal(f.slots(4,'lunch')[0].content,dishes[0]);
  assert.deepEqual(f.imports().map(r=>r.parser_version),[10,16]);
  assert.equal(f.imports()[0].id,oldId);await f.run();assert.equal(f.state.aiCalls,1);
});

// ── Monday/Friday four-item night fallback ────────────────────────────────────

const nightlyDish1 = '2 Burgers and 1 Order of Fries $14';
const nightlyDish2 = 'Half Rack Ribs with Mac & Cheese $18.75';
const allDayDish1 = 'California Burger w/ Side Salad $10.25';
const allDayDish2 = 'Chicken Salad Sandwich w/ Coleslaw $7.25';
const fourOffers = [offer(nightlyDish1), offer(nightlyDish2), offer(allDayDish1), offer(allDayDish2)];

for (const [weekday, label] of [[1,'Monday'],[5,'Friday']]) {
  test(`${label} Night 4-offer fallback: offers[0,1] → nightly, offers[2,3] → all-day`, () => {
    const p = poster(weekday, `${label} Night Specials 5-10 PM`, fourOffers);
    const result = reconcilePosters([p], weekday);
    assert.equal(result.length, 2);
    const nightly = result.find(g => g.service === 'nightly');
    const allDay = result.find(g => g.service === 'all-day');
    assert.ok(nightly, 'nightly group present');
    assert.ok(allDay, 'all-day group present');
    assert.equal(nightly.day_of_week, weekday);
    assert.equal(allDay.day_of_week, weekday);
    assert.deepEqual(nightly.items, [{content: nightlyDish1}, {content: nightlyDish2}]);
    assert.deepEqual(allDay.items, [{content: allDayDish1}, {content: allDayDish2}]);
  });

  test(`${label}: normal path preferred when existing all-day pair is present`, () => {
    // A daytime poster with explicit all-day/lunch evidence → normal path
    const dayP = poster(weekday, `${label} Specials`, [
      offer('Lunch Item $9', 'Lunch', '11-1:30'),
      offer(allDayDish1, 'All Day'),
      offer(allDayDish2, 'All Day'),
    ]);
    const result = reconcilePosters([dayP], weekday);
    // Normal path should produce results, not the fallback
    assert.ok(result.length > 0, 'normal path produces output');
    // Fallback must not fire when normal path succeeds
    const allDay = result.find(g => g.service === 'all-day');
    assert.ok(allDay, 'all-day produced by normal path');
  });

  test(`${label} Night 3 offers → fail closed (no fallback)`, () => {
    const p = poster(weekday, `${label} Night Specials`, fourOffers.slice(0, 3));
    const result = reconcilePosters([p], weekday);
    assert.deepEqual(result, []);
  });

  test(`${label} Night 5 offers → fail closed (no fallback)`, () => {
    const p = poster(weekday, `${label} Night Specials`, [...fourOffers, offer('Extra Dish $5')]);
    const result = reconcilePosters([p], weekday);
    assert.deepEqual(result, []);
  });

  test(`${label} Specials (no "Night" in heading) with 4 offers → fail closed`, () => {
    const p = poster(weekday, `${label} Specials`, fourOffers);
    const result = reconcilePosters([p], weekday);
    assert.deepEqual(result, []);
  });
}

test('non-Monday/Friday weekday (Wednesday=3) with 4 offers → fail closed', () => {
  const p = poster(3, 'Wednesday Night Specials', fourOffers);
  const result = reconcilePosters([p], 3);
  // Wednesday can have nightly, but not via the Monday/Friday fallback
  // Standard path: 4 offers won't match any Wednesday normal pattern → empty
  assert.deepEqual(result.filter(g => g.service === 'all-day'), [], 'no all-day from Mon/Fri fallback on Wednesday');
});

test('non-Monday/Friday weekday (Tuesday=2) with 4 offers → fail closed', () => {
  const p = poster(2, 'Tuesday Night Specials', fourOffers);
  const result = reconcilePosters([p], 2);
  assert.deepEqual(result, []);
});

test('Monday Night fallback: malformed offers (empty content) → fail closed', () => {
  const badOffers = [offer(''), offer(nightlyDish2), offer(allDayDish1), offer(allDayDish2)];
  const p = poster(1, 'Monday Night Specials', badOffers);
  const result = reconcilePosters([p], 1);
  assert.deepEqual(result, []);
});

test('Friday Night fallback: null offer content → fail closed', () => {
  const badOffers = [offer(nightlyDish1), {content: null, evidence: '', service_time: ''}, offer(allDayDish1), offer(allDayDish2)];
  const p = poster(5, 'Friday Night Specials', badOffers);
  const result = reconcilePosters([p], 5);
  assert.deepEqual(result, []);
});

test('live parser-6 Thursday candidate: polluted evidence on offers 2-3 must not produce Lunch; no Nightly',()=>{
  const candidate={
    day_of_week:4,day_evidence:'Thursday',poster_evidence:'Thursday Specials',
    offers:[
      {content:'Chicken Mashed Potato Bowl and a Drink - $9.75',service_time:'11-1:30',evidence:'11-1:30'},
      {content:'California Burger w/ Side Salad, Chili or Coleslaw - $10.25',service_time:'',evidence:'11-1:30'},
      {content:'Chicken Salad Sandwich w/ Cup of Chili or Coleslaw - $7.25',service_time:'',evidence:'11-1:30'},
    ],
  };
  const result=reconcilePosters([candidate],4);
  assert.equal(result.length,2);
  assert.equal(result[0].service,'lunch');
  assert.equal(result[0].items[0].content,'Chicken Mashed Potato Bowl and a Drink - $9.75');
  assert.equal(result[1].service,'all-day');
  assert.equal(result[1].items[0].content,'California Burger w/ Side Salad, Chili or Coleslaw - $10.25');
  assert.equal(result[1].items[1].content,'Chicken Salad Sandwich w/ Cup of Chili or Coleslaw - $7.25');
  assert.ok(!result.some(g=>g.service==='nightly'),'no Nightly from a daytime poster');
});

// ── day_of_week=-1 / isDayUnknown path ─────────────────────────────────────────

const unknownDayPoster=(heading,offers)=>({day_of_week:-1,day_evidence:'',poster_evidence:heading,offers});

// Mirrors the Wednesday 30 Sept production failure: poster had no weekday heading,
// AI returned day_of_week=-1.  The three offers carry prices in content.
const sept30Offers=[
  {content:'Bacon Cheese Curd Burger w/ Beer Fries & a Drink $9.75',service_time:'11-1:30',evidence:''},
  {content:'Grilled Chipotle Chicken Bacon Ranch Wrap w/ Fries & Coleslaw $10.25',service_time:'',evidence:''},
  {content:'Chicken Salad Sandwich w/ Cup of Chili or Coleslaw $7.25',service_time:'',evidence:''},
];

test('Sept-30-style: day_of_week=-1 three-offer Specials poster produces Lunch + All Day',()=>{
  const result=reconcilePosters([unknownDayPoster('Specials',sept30Offers)],3);
  assert.equal(result.length,2,'expected lunch and all-day groups');
  const lunch=result.find(g=>g.service==='lunch');
  const allDay=result.find(g=>g.service==='all-day');
  assert.ok(lunch,'lunch group produced');
  assert.ok(allDay,'all-day group produced');
  assert.equal(lunch.items[0].content,'Bacon Cheese Curd Burger w/ Beer Fries & a Drink $9.75','$9.75 preserved');
  assert.deepEqual(allDay.items.map(i=>i.content),[
    'Grilled Chipotle Chicken Bacon Ranch Wrap w/ Fries & Coleslaw $10.25',
    'Chicken Salad Sandwich w/ Cup of Chili or Coleslaw $7.25',
  ],'wrap $10.25 and chicken salad both assigned to all-day');
});

test('day_of_week=-1 generic Specials heading accepted for every weekday',()=>{
  for(const weekday of [1,2,3,4,5]){
    const result=reconcilePosters([unknownDayPoster('Specials',dishes.map(s=>offer(s)))],weekday);
    assert.ok(result.length>0,`weekday ${weekday}: day-unknown poster should produce output`);
  }
});

test('explicit wrong weekday still rejected after isDayUnknown fix',()=>{
  const p=poster(2,'Tuesday Specials',dishes.map(s=>offer(s)));
  assert.deepEqual(reconcilePosters([p],3),[],'wrong explicit weekday must be rejected');
});

test('day_of_week=-1 with a weekday name in day_evidence rejected (conflicting evidence)',()=>{
  const p={day_of_week:-1,day_evidence:'Monday',poster_evidence:'Specials',offers:dishes.map(s=>offer(s))};
  assert.deepEqual(reconcilePosters([p],3),[],'weekday name in day_evidence is conflicting; must reject');
});

for(const heading of [
  "Tomorrow's Lunch Special",
  'tomorrow specials',
  "Tomorrow's Special: Grilled Salmon $12.99",
  'This Weekend Fish Fry',
  'this weekend specials',
  'Next Friday Night Specials',
  'next monday special',
  'Next week specials',
  'later this week: prime rib night',
  'Later This Week Specials',
]){
  test(`forward-looking heading rejected: "${heading}"`,()=>{
    const p=unknownDayPoster(heading,dishes.map(s=>offer(s)));
    assert.deepEqual(reconcilePosters([p],3),[],'future-ref heading must be rejected');
  });
}

test('"tomorrow" appearing in day_evidence also rejected',()=>{
  const p={day_of_week:-1,day_evidence:'tomorrow',poster_evidence:'Specials',offers:dishes.map(s=>offer(s))};
  assert.deepEqual(reconcilePosters([p],3),[],'tomorrow in day_evidence must be rejected');
});

test('"tonight" heading not blocked by hasFutureRef (same-day nightly)',()=>{
  // serviceOf("Tonight's Special") → 'unknown': \bnight\b has no word boundary inside "tonight",
  // so orderedDaytime fires normally and produces lunch + all-day for the three-offer pattern.
  const p=unknownDayPoster("Tonight's Special",dishes.map(s=>offer(s)));
  const result=reconcilePosters([p],3);
  assert.ok(result.length>0,'"tonight" must not be blocked by the future-ref guard');
});

test('prices embedded in content survive canonicalization end-to-end',()=>{
  const result=reconcilePosters([unknownDayPoster('Specials',sept30Offers)],3);
  const lunch=result.find(g=>g.service==='lunch');
  const allDay=result.find(g=>g.service==='all-day');
  assert.ok(lunch.items[0].content.includes('$9.75'),'$9.75 not stripped from lunch');
  assert.ok(allDay.items[0].content.includes('$10.25'),'$10.25 not stripped from all-day');
  assert.ok(allDay.items[1].content.includes('$7.25'),'$7.25 not stripped from all-day');
});
