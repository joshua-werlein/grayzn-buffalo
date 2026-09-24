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
for(const evidence of ['Nightly','Wing Night','5–10 PM','Lunch and Night']) test(`per-offer ${evidence} blocks daytime fallback`,()=>{
  const p=daytime();p.offers[0].evidence=evidence;
  assert.ok(reconcilePosters([p],4).every(g=>!['lunch','all-day'].includes(g.service)));
});
test('explicit evidence in other positions is never overridden by offer order',()=>{
  const p=daytime();p.offers[1].evidence='Lunch';
  const groups=reconcilePosters([p],4);
  assert.equal(groups.find(g=>g.service==='lunch').items[0].content,dishes[1]);
  p.offers[1].evidence='';p.offers[0].evidence='All Day';
  assert.deepEqual(reconcilePosters([p],4),[]);
});
test('matching partial service evidence supports the same three-offer pattern',()=>{
  const p=daytime();p.offers[2].evidence='All Day';
  assert.deepEqual(reconcilePosters([p],4),expected);
});
test('weekends, wrong weekday, non-specials headings, and other offer counts stay outside the rule',()=>{
  for(const day of [0,6]) assert.deepEqual(reconcilePosters([poster(day,'Specials',dishes.map(s=>offer(s)))],day),[]);
  assert.deepEqual(reconcilePosters([daytime()],3),[]);
  for(const heading of ['Thursday','Thursday Weekly Specials']) {
    const p=daytime();p.poster_evidence=heading;assert.deepEqual(reconcilePosters([p],4),[]);
  }
  for(const offers of [dishes.slice(0,2),[...dishes,'Another offer $5']]) assert.deepEqual(reconcilePosters([poster(4,'Thursday Specials',offers.map(s=>offer(s)))],4),[]);
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
test('parser 6 reprocesses a Thursday source claimed by parser 5 without deleting history',async t=>{
  assert.equal(PARSER_VERSION,6);
  const f=makeHarness(t);const raw=f.state.posts[0];
  const digest=(s,n)=>createHash('sha256').update(s).digest('hex').slice(0,n*2);
  const captionHash=digest(raw.message,8), version=`updated:${raw.updated_time}`;
  const model='@cf/meta/llama-3.2-11b-vision-instruct';
  const oldId=digest(`test:${raw.id}:${captionHash}:${version}:5:${model}`,16);
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,caption_hash,image_source_version,parser_version,model_id,processing_status,fetched_at)
    VALUES(?,?,?,?,?,5,?,'staged',?)`,oldId,raw.id,raw.created_time,captionHash,version,model,raw.created_time);
  await f.run();assert.equal(f.state.aiCalls,1);assert.equal(f.slots(4,'lunch')[0].content,dishes[0]);
  assert.deepEqual(f.imports().map(r=>r.parser_version),[5,6]);
  assert.equal(f.imports()[0].id,oldId);await f.run();assert.equal(f.state.aiCalls,1);
});
