import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateEvidence,reconcilePosterEvidence} from './reconcile.js';
import {reconcileToday} from './guarded-auto.js';
import {harness} from './test-fixture.js';
import {soupGroupId} from '../../src/lib/daily-soup.js';

// Exact extracted_json from production import 7276d795cf8df30e7627cf85ebb27fe6.
const exact=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct11-sunday.json',import.meta.url),'utf8'));
const clone=()=>structuredClone(exact);
const names=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const meals=['16" 3-Topping Pizza 12 Wings $30','Olive Burger w/ Side Salad, Soup or Coleslaw $10.25','Chicken Salad Sandwich w/ Cup of Soup or Coleslaw $7.25'];
const soups='Beer Cheese, French Onion or Chili';
const expected=day=>[
  {day_of_week:day,service:'lunch',items:[{content:meals[0]}]},
  {day_of_week:day,service:'all-day',items:meals.slice(1).map(content=>({content}))},
  {day_of_week:day,service:'custom',role:'soup',items:[{content:soups}]},
];
const reconcile=(p,day=0,today='2026-10-11')=>reconcilePosterEvidence([p],day,[],{today});
const snapshot=f=>[
  f.sql('SELECT * FROM special_collections ORDER BY id'),
  f.sql('SELECT * FROM special_groups ORDER BY id'),
  f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),
  f.sql('SELECT * FROM special_import_events ORDER BY id'),f.imports(),
];
function setup(t,{day=0,candidate=clone()}={}) {
  const today=day===6?'2026-10-10':day===1?'2026-10-12':'2026-10-11';
  const f=harness(t,{now:`${today}T16:00:00Z`,caption:'',candidate,mode:'DRY_RUN'});
  f.sql('UPDATE weekly_specials SET week_start_date=?,week_end_date=? WHERE id=9000',day===1?'2026-10-12':'2026-10-05',day===1?'2026-10-18':'2026-10-11');
  Object.assign(f.state.posts[0],{id:'583672228384067_1730327925301751',created_time:`${today}T14:39:46+0000`,updated_time:`${today}T14:39:46+0000`});
  for(const [service,position,content] of [['lunch',1,'16” 3-Topping Pizza & 12 Wings'],['all-day',2,'Chicken Salad Sandwich with cup of Chili or Coleslaw']])
    f.sql("UPDATE special_slots SET content=?,origin='manual',manual_locked=0,last_auto_value=NULL WHERE group_id=? AND position=?",content,f.slots(day,service)[0].group_id,position);
  return {...f,today,day};
}
async function stage(f) {
  await f.run();assert.equal(f.imports()[0].processing_status,'staged');
  f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  f.env.AI.run=async()=>{throw Error('Existing staged source must not invoke AI');};
}

test('exact October 11 heading-only weekday preserves all meal prices, options, and separate Soup',()=>{
  const before=clone();assert.deepEqual(validateEvidence(exact).offers,exact.offers);
  assert.deepEqual(reconcile(exact),{targets:expected(0),rejectedSources:[],unresolvedTargets:[]});
  assert.deepEqual(exact,before);
});
for(let day=0;day<7;day++) test(`matching heading with missing day_evidence works for ${names[day]}`,()=>{
  const p=clone();p.day_of_week=day;p.poster_evidence=`${names[day]} Specials`;
  assert.deepEqual(reconcile(p,day,undefined).targets,expected(day));
});
for(const numeric of [-1,0]) test(`no printed weekday permits same-day fallback with numeric ${numeric}`,()=>{
  const p=clone();p.day_of_week=numeric;p.poster_evidence='Specials';
  assert.deepEqual(reconcile(p).targets,expected(0));
});
for(const change of [
  p=>p.day_evidence='Monday',
  p=>p.poster_evidence='Monday Specials',
  p=>p.poster_evidence='Sunday Monday Specials',
  p=>p.day_evidence='Sunday Monday',
  p=>p.day_of_week=1,
  p=>{p.day_of_week=-1;p.poster_evidence='Sunday Specials';},
  p=>{p.day_of_week=1;p.day_evidence='Monday';p.poster_evidence='Monday Specials';},
  p=>{p.day_of_week=1;p.poster_evidence='Specials';},
  p=>p.poster_evidence='Sunday Specials tomorrow',
  p=>p.poster_evidence='Next Sunday Specials',
  p=>{p.day_of_week=-1;p.poster_evidence='Tomorrow Specials';},
  p=>p.poster_evidence='Sunday Specials 2026-10-18',
  p=>p.poster_evidence='Sunday Specials 10/18/2026',
  p=>p.poster_evidence='Sunday Specials October 18, 2026',
  p=>p.poster_evidence='Sunday Specials yesterday',
]) test(`conflicting or other-date evidence fails closed: ${change.toString()}`,()=>{
  const p=clone();change(p);const result=reconcile(p);
  assert.deepEqual(result.targets,[]);assert.equal(result.rejectedSources.length,1);
  assert.ok(result.rejectedSources[0].reason);
});
for(const date of ['2026-10-11','10/11/2026','Oct 11, 2026']) test(`matching printed date ${date} is eligible`,()=>{
  const p=clone();p.poster_evidence=`Sunday Specials ${date}`;assert.deepEqual(reconcile(p).targets,expected(0));
});

for(const day of [0,6,1]) test(`${names[day]} normal scan reuses staged evidence, replaces defaults and is idempotent`,async t=>{
  const p=clone();p.day_of_week=day;p.poster_evidence=`${names[day]} Specials`;
  const f=setup(t,{day,candidate:p});await stage(f);const saved=f.imports()[0];
  const unrelated=f.sql('SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id<>? OR g.day_of_week<>?', 'auto-week',day);
  const nightly=f.slots(day,'nightly');await f.run();
  assert.equal(f.slots(day,'lunch')[0].content,meals[0]);
  assert.deepEqual(f.slots(day,'all-day').map(s=>s.content),[...meals.slice(1),'','']);
  const soup=f.sql('SELECT * FROM special_slots WHERE group_id=? ORDER BY position',soupGroupId('auto-week',day));
  assert.equal(soup.length,4);assert.equal(soup[0].content,soups);
  assert.ok(soup.slice(1).every(s=>s.content===''));
  for(const s of [f.slots(day,'lunch')[0],...f.slots(day,'all-day').slice(0,2),soup[0]]) {
    assert.equal(s.origin,'automation');assert.equal(s.manual_locked,0);assert.equal(s.last_auto_value,s.content);assert.equal(s.price,'');
  }
  assert.deepEqual(f.slots(day,'nightly'),nightly);
  assert.deepEqual(f.sql('SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id<>? OR g.day_of_week<>?', 'auto-week',day),unrelated);
  assert.equal(f.state.aiCalls,1);assert.deepEqual(f.imports()[0],saved);
  assert.match(f.sql("SELECT detail FROM special_import_events WHERE event_type='review'")[0].detail,/4 slot\(s\)/);
  const before=snapshot(f);await f.run();await f.run();assert.deepEqual(snapshot(f),before);
});
test('same-day Graph timestamp fallback publishes a poster with no weekday anywhere',async t=>{
  const p=clone();p.day_of_week=-1;p.poster_evidence='Specials';const f=setup(t,{candidate:p});
  await stage(f);await f.run();assert.equal(f.slots(0,'lunch')[0].content,meals[0]);
});
for(const protection of ['staff meal','extra meal','disabled lunch','staff soup']) test(`Sunday staged recovery respects ${protection}`,async t=>{
  const f=setup(t);await stage(f);const lunch=f.slots(0,'lunch')[0].group_id,soup=soupGroupId('auto-week',0);
  if(protection==='staff meal') f.sql("UPDATE special_slots SET content='Staff meal $8',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",lunch);
  if(protection==='extra meal') f.sql("UPDATE special_slots SET content='Staff extra $5',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",lunch);
  if(protection==='disabled lunch') f.sql('UPDATE special_groups SET enabled=0 WHERE id=?',lunch);
  if(protection==='staff soup') {
    f.sql("INSERT INTO special_groups VALUES(?,'auto-week',0,'custom','Soup','',99,1)",soup);
    f.sql("INSERT INTO special_slots(group_id,position,content,origin,manual_locked) SELECT ?,value,CASE WHEN value=1 THEN 'Staff Soup' ELSE '' END,'manual',1 FROM json_each('[1,2,3,4]')",soup);
  }
  const group=protection==='staff soup'?soup:lunch,before=f.sql('SELECT * FROM special_slots WHERE group_id=? ORDER BY position',group);
  await f.run();assert.deepEqual(f.sql('SELECT * FROM special_slots WHERE group_id=? ORDER BY position',group),before);
  assert.deepEqual(f.slots(0,'all-day').slice(0,2).map(s=>s.content),meals.slice(1));
  const published=snapshot(f);await f.run();assert.deepEqual(snapshot(f),published);
});
for(const invalid of ['weekday','heading','future heading','calendar date','yesterday timestamp','future timestamp','invalid timestamp'])
  test(`excluded ${invalid} records an actionable guarded diagnostic once`,async t=>{
    const f=setup(t);await stage(f);const p=clone();
    if(invalid==='weekday') p.day_evidence='Monday';
    if(invalid==='heading') p.poster_evidence='Monday Specials';
    if(invalid==='future heading') p.poster_evidence='Tomorrow Sunday Specials';
    if(invalid==='calendar date') p.poster_evidence='Sunday Specials 10/18';
    f.sql('UPDATE special_imports SET candidate_json=? WHERE id=?',JSON.stringify(p),f.imports()[0].id);
    if(invalid.includes('timestamp')) f.sql('UPDATE special_imports SET fb_created_time=? WHERE id=?',invalid==='invalid timestamp'?'bad':invalid==='future timestamp'?'2026-10-11T23:00:00Z':'2026-10-10T14:39:46Z',f.imports()[0].id);
    const groups=f.sql('SELECT * FROM special_groups ORDER BY id'),slots=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
    const run=()=>reconcileToday(f.env,{sourceIds:[f.imports()[0].id],today:f.today,weekday:0});
    const result=await run();assert.equal(result.written,false);assert.equal(result.rejectedSources.length,1);
    assert.match(result.reason,/CONFLICT/);
    assert.deepEqual(f.sql('SELECT * FROM special_groups ORDER BY id'),groups);assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),slots);
    const audits=f.sql("SELECT * FROM special_import_events WHERE event_type='review'");assert.equal(audits.length,2);
    assert.match(audits.at(-1).detail,/weekday|date|timestamp/);
    const before=snapshot(f);await run();await run();assert.deepEqual(snapshot(f),before);
  });
for(const now of ['2026-10-12T01:00:00Z','2026-10-12T02:00:00Z','2026-10-12T16:00:00Z'])
  test(`Sunday staged evidence cannot publish at cutoff or on later date ${now}`,async t=>{
    const f=setup(t);await stage(f);f.state.now=Date.parse(now);
    const sunday=()=>f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='auto-week' AND g.day_of_week=0 ORDER BY s.group_id,s.position");
    const before=sunday();await f.run();assert.deepEqual(sunday(),before);
    assert.equal(f.sql("SELECT * FROM special_import_events WHERE event_type='review'").length,0);assert.equal(f.state.aiCalls,1);
  });
test('source timestamp race invalidates meal, Soup creation, revision and audit together',async t=>{
  const f=setup(t);await stage(f);const before=snapshot(f),batch=f.env.DB.batch;
  f.env.DB.batch=statements=>{
    if(statements[0].sql.startsWith('UPDATE special_collections'))
      f.sql("UPDATE special_imports SET fb_created_time='2026-10-10T14:39:46Z'");
    return batch(statements);
  };
  await f.run();const after=snapshot(f);
  assert.deepEqual(after.slice(0,4),before.slice(0,4));assert.equal(f.state.aiCalls,1);
});
