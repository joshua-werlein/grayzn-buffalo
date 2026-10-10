import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reconcilePosterEvidence, singleDayLunchEvidence} from './reconcile.js';
import {standaloneSoup, soupGroupId} from '../../src/lib/daily-soup.js';
import {harness, offer} from './test-fixture.js';
import {PARSER_VERSION} from './classify.js';

// Exact production extracted_json: import 494c0b4742408f02c26da116cc39c2a9.
const exact=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct10-saturday.json',import.meta.url),'utf8'));
const soups='French Onion, Chili or Beer Cheese Soup';
const meals=exact.offers.slice(0,3).map(o=>o.content);
const clone=()=>structuredClone(exact);
function setup(t) {
  const f=harness(t,{now:'2026-10-10T15:00:00Z',caption:'🍻 🍺',candidate:clone(),mode:'DRY_RUN'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-05',week_end_date='2026-10-11' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'583672228384067_1729295168738360',created_time:'2026-10-10T14:21:49+0000',updated_time:'2026-10-10T14:21:49+0000'});
  for(const [service,position,content] of [['lunch',1,'Philly & French Fries'],['all-day',2,'Chicken Salad Sandwich with cup of Chili or Coleslaw']])
    f.sql("UPDATE special_slots SET content=?,origin='manual',manual_locked=0 WHERE group_id=? AND position=?",content,f.slots(6,service)[0].group_id,position);
  return f;
}
const snapshot=f=>[
  f.sql('SELECT * FROM special_collections ORDER BY id'),
  f.sql('SELECT * FROM special_groups ORDER BY id'),
  f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),
  f.sql('SELECT * FROM special_import_events ORDER BY id'),
  f.imports(),f.state.aiCalls,
];

for(const day of [6,0]) for(const prefix of ['Soup:','Soups:'])
  test(`October 10 meals plus ${prefix} map on weekend ${day} without losing included sides`,()=>{
    const p=clone();p.day_of_week=day;p.day_evidence=day===6?'Saturday':'Sunday';p.poster_evidence=`${p.day_evidence} Oktoberfest Specials`;
    p.offers[3]=offer(`${prefix} ${soups}`,`${prefix} ${soups}`);
    const before=structuredClone(p),result=reconcilePosterEvidence([p],day);
    assert.deepEqual(result.rejectedSources,[]);
    assert.deepEqual(result.targets,[
      {day_of_week:day,service:'lunch',items:[{content:meals[0]}]},
      {day_of_week:day,service:'all-day',items:meals.slice(1).map(content=>({content}))},
      {day_of_week:day,service:'custom',role:'soup',items:[{content:soups}]},
    ]);
    assert.deepEqual(p,before);
  });

for(const prefix of ['Soup:','Soups:',' SOUPS :']) test(`${prefix} requires matching standalone untimed soup evidence`,()=>{
  assert.equal(standaloneSoup(offer(`${prefix} ${soups}`,`Soup: ${soups}`)),soups);
  for(const text of ['','Soups','Soup','or','French Onion or','Cup of Soup with sandwich','Burger with soup','Ask today'])
    assert.equal(standaloneSoup(offer(`${prefix} ${text}`,`${prefix} ${text}`)),null);
  for(const o of [offer(`${prefix} ${soups}`,''),offer(`${prefix} ${soups}`,'Soup: Tomato'),offer(`${prefix} ${soups}`,`${prefix} ${soups}`,'Lunch'),...exact.offers.slice(1,3)])
    assert.equal(standaloneSoup(o),null);
});

for(const prefix of ['Soup:','Soups:']) test(`single-day lunch recovery recognizes ${prefix} while preserving meal sides`,()=>{
  const p={type:'weekly-lunch',poster_evidence:'Friday Lunch Specials',service_time:'11 AM - 1:30 PM',entries:exact.offers.map((o,i)=>({day_of_week:5,content:i===3?`${prefix} ${soups}`:o.content}))};
  assert.equal(singleDayLunchEvidence(p).offers.length,4);
  const result=reconcilePosterEvidence([p],5);
  assert.deepEqual(result.rejectedSources,[]);
  assert.deepEqual(result.targets.map(g=>g.items.map(o=>o.content)),[[meals[0]],meals.slice(1),[soups]]);
});

test('next cron reuses staged Parser 18 evidence, replaces production-shaped defaults, and remains idempotent',async t=>{
  const f=setup(t);await f.run();
  const staged=f.imports()[0];
  assert.equal(staged.processing_status,'staged');assert.equal(staged.validation_result,'ok');
  assert.equal(staged.retry_count,1);assert.equal(staged.parser_version,18);assert.equal(PARSER_VERSION,18);
  assert.deepEqual(JSON.parse(staged.extracted_json),exact);
  assert.equal(f.sql("SELECT * FROM special_import_events WHERE event_type='review'").length,0);
  f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';f.state.aiCalls=0;
  f.env.AI.run=async()=>{throw Error('Staged evidence must not rerun AI');};
  const defaults=f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='defaults'");
  const nightly=f.slots(6,'nightly');
  await f.run();
  assert.equal(f.slots(6,'lunch')[0].content,meals[0]);
  assert.deepEqual(f.slots(6,'all-day').map(s=>s.content),[...meals.slice(1),'','']);
  const group=soupGroupId('auto-week',6),soup=f.sql('SELECT * FROM special_slots WHERE group_id=? ORDER BY position',group);
  assert.equal(soup.length,4);assert.equal(soup[0].content,soups);assert.ok(soup.slice(1).every(s=>s.content===''));
  for(const slot of [f.slots(6,'lunch')[0],...f.slots(6,'all-day').slice(0,2),soup[0]]) {
    assert.equal(slot.origin,'automation');assert.equal(slot.manual_locked,0);assert.equal(slot.last_auto_value,slot.content);
  }
  assert.deepEqual(f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='defaults'"),defaults);
  assert.deepEqual(f.slots(6,'nightly'),nightly);assert.equal(f.state.aiCalls,0);assert.equal(f.imports()[0].retry_count,1);
  assert.equal(f.imports()[0].extracted_json,staged.extracted_json);assert.equal(f.imports()[0].candidate_json,staged.candidate_json);
  const before=snapshot(f);await f.run();await f.run();assert.deepEqual(snapshot(f),before);
});

for(const protection of ['staff meal','disabled lunch','extra meal','staff soup','hidden soup'])
  test(`October 10 staged recovery protects ${protection} and repeated cron produces no churn`,async t=>{
    const f=setup(t);await f.run();f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
    const lunch=f.slots(6,'lunch')[0].group_id,soup=soupGroupId('auto-week',6);
    if(protection==='staff meal') f.sql("UPDATE special_slots SET content='Staff meal $8',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",lunch);
    if(protection==='disabled lunch') f.sql('UPDATE special_groups SET enabled=0 WHERE id=?',lunch);
    if(protection==='extra meal') f.sql("UPDATE special_slots SET content='Staff extra $5',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",lunch);
    if(protection.includes('soup')) {
      f.sql("INSERT INTO special_groups VALUES(?,'auto-week',6,'custom','Soup','',99,?)",soup,protection==='hidden soup'?0:1);
      f.sql("INSERT INTO special_slots(group_id,position,content,origin,manual_locked) SELECT ?,value,CASE WHEN value=1 THEN 'Staff soup' ELSE '' END,'manual',1 FROM json_each('[1,2,3,4]')",soup);
    }
    const protectedGroup=protection.includes('soup')?soup:lunch,before=f.sql('SELECT * FROM special_slots WHERE group_id=? ORDER BY position',protectedGroup);
    await f.run();assert.deepEqual(f.sql('SELECT * FROM special_slots WHERE group_id=? ORDER BY position',protectedGroup),before);
    assert.deepEqual(f.slots(6,'all-day').slice(0,2).map(s=>s.content),meals.slice(1));
    assert.match(f.sql("SELECT detail FROM special_import_events WHERE event_type='review' ORDER BY id DESC")[0].detail,/CONFLICT/);
    const published=snapshot(f);await f.run();assert.deepEqual(snapshot(f),published);
    assert.equal(f.state.aiCalls,1);assert.equal(f.imports()[0].retry_count,1);
  });

test('staged October 10 recovery does not publish at the 8 PM Chicago cutoff',async t=>{
  const f=setup(t);await f.run();f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';f.state.now=Date.parse('2026-10-11T01:00:00Z');
  const before=snapshot(f);await f.run();assert.deepEqual(snapshot(f),before);
});
