import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyzeDailyEvidence,joinProteinVariants} from './evidence.js';
import {reconcilePosterEvidence} from './reconcile.js';
import {harness} from './test-fixture.js';

// Public poster transcriptions only (stored October 23 extractions): the
// undated DAILY SPECIALS morning poster, the five-offer "Friday Night Specials
// 5-10pm" poster and the separate Brewers game promotion (a special event,
// deliberately NOT part of the ordinary Friday Nightly specials).
const read=name=>JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`,import.meta.url),'utf8'));
const morningRaw=read('oct23-delivery.json');
const {friday_night:nightRaw,brewers_event:brewersRaw}=read('oct23-friday-night.json');
const stored=(raw,edit=p=>p)=>{const p=structuredClone(raw);edit(p);return analyzeDailyEvidence(p);};
const morning=()=>stored(morningRaw),night=edit=>stored(nightRaw,edit),brewers=()=>stored(brewersRaw);
const NIGHTLY=['1 or 2 Piece Fish + 3 Jumbo Shrimp + Fries & Coleslaw or Side Salad $12.99/$13.99',
  'Chicken Stir Fry $12.99\nSteak Stir Fry $13.99','Cheeseburger or Fish Sandwich w/Side Salad, Soup or Coleslaw $10.75'];
const ALL_DAY=['Cheeseburger or Fish Sandwich w/ Side Salad, Soup or Coleslaw $10.25','Grilled Ham and Cheese w/ Cup of Soup or Coleslaw $7.25'];
const route=(candidates,{day=5,existing=[]}={})=>reconcilePosterEvidence(candidates,day,existing,{
  today:'2026-10-23',verifiedSameDaySources:new Set(candidates.map((_,i)=>i))});
const items=(r,service)=>r.targets.find(t=>(t.role??t.service)===service)?.items.map(i=>i.content);

test('production October 23, both orders: three Friday Nightly specials; All Day keeps its $10.25 price; repeat not duplicated',()=>{
  for(const candidates of [[morning(),night()],[night(),morning()]]) {
    const r=route(candidates);
    assert.deepEqual(r.unresolvedTargets,[]);
    assert.deepEqual(items(r,'nightly'),NIGHTLY);
    assert.deepEqual(r.targets.find(t=>t.service==='nightly').items.map(i=>i.position),[1,2,3]);
    assert.deepEqual(items(r,'all-day'),ALL_DAY);
    assert.deepEqual(items(r,'lunch'),['Fish Sandwich w/ Fries + Drink $9.75']);
    assert.deepEqual(items(r,'soup'),['Chicken Noodle or Chili']);
  }
});

test('evening poster after the morning publication: published All Day automation identifies the repeat',()=>{
  const r=route([night()],{existing:ALL_DAY.map(content=>({content}))});
  assert.deepEqual(items(r,'nightly'),NIGHTLY);
  assert.deepEqual(items(r,'all-day'),['Grilled Ham and Cheese w/cup of Soup or Coleslaw $7.25']);
});

test('without any All Day evidence for today the Friday Night poster stays held',()=>{
  const r=route([night()]);
  assert.ok(!items(r,'nightly'));assert.ok(!items(r,'all-day'));
  assert.ok(r.unresolvedTargets.length);
});

test('the Brewers special-event poster is never folded into or blocks Friday Nightly',()=>{
  for(const candidates of [[morning(),night(),brewers()],[brewers(),night(),morning()]]) {
    const r=route(candidates);
    assert.deepEqual(items(r,'nightly'),NIGHTLY);
    assert.ok(!r.targets.flatMap(t=>t.items).some(i=>/pulled pork sandwich/i.test(i.content)));
    assert.deepEqual(r.unresolvedTargets.map(u=>u.reason),['Service not established by evidence']);
  }
});

test('four Friday Nightly specials fit; a fifth holds the whole service and drops nothing',()=>{
  const add=(...offers)=>night(p=>p.offers.splice(3,0,...offers.map(content=>({...p.offers[1],content,evidence:content}))));
  const four=route([morning(),add('Prime Rib $24.99')]);
  assert.deepEqual(items(four,'nightly'),[...NIGHTLY.slice(0,2),'Prime Rib $24.99',NIGHTLY[2]]);
  const five=route([morning(),add('Prime Rib $24.99','Walleye Dinner $18.99')]);
  assert.ok(!items(five,'nightly'));
  // The held $10.75 Cheeseburger also holds the same-dish All Day proposal
  // (existing safeguard), so published daytime values are left as they are.
  assert.ok(!five.targets.flatMap(t=>t.items).some(i=>/\$10\.75|Prime Rib|Walleye/.test(i.content)));
  assert.ok(five.unresolvedTargets.some(u=>u.reason==='Unresolved offer could contradict this offer'));
});

test('night price variants publish at night; only identical repeats are recognized as All Day',()=>{
  const r=route([morning(),night(p=>{p.offers[4].content=p.offers[4].evidence='Grilled Ham and Cheese w/cup of Soup or Coleslaw $7.75';})]);
  assert.deepEqual(items(r,'nightly'),[...NIGHTLY,'Grilled Ham and Cheese w/cup of Soup or Coleslaw $7.75']);
  assert.deepEqual(items(r,'all-day'),ALL_DAY);
});

test('stir fry variants join only as adjacent, complete, same-dish, distinct-protein offers',()=>{
  const join=edit=>{const p=structuredClone(nightRaw);edit(p);return joinProteinVariants(p).offers.map(o=>o.content);};
  assert.deepEqual(join(()=>{}).slice(1,2),['Chicken Stir Fry $12.99\nSteak Stir Fry $13.99']);
  const refused=[
    ['missing price',p=>{p.offers[2].content=p.offers[2].evidence='Steak Stir Fry';}],
    ['evidence price differs',p=>{p.offers[2].evidence='Steak Stir Fry $14.99';}],
    ['same protein twice',p=>{p.offers[2].content=p.offers[2].evidence='Chicken Stir Fry $13.99';}],
    ['different dish',p=>{p.offers[2].content=p.offers[2].evidence='Steak Sandwich Platter $13.99';}],
    ['one-word dish',p=>{p.offers[1].content=p.offers[1].evidence='Chicken Wrap $12.99';p.offers[2].content=p.offers[2].evidence='Steak Wrap $13.99';}],
    ['not a listed protein',p=>{p.offers[1].content=p.offers[1].evidence='Veggie Stir Fry $12.99';}],
    ['different service',p=>{p.offers[2].service_time='11-1:30';}],
    ['uncertain',p=>{p.offers[2].uncertainties=['price unclear'];}],
    ['not adjacent',p=>{p.offers=[p.offers[1],p.offers[0],p.offers[2],p.offers[3],p.offers[4]];}],
    ['daytime heading',p=>{p.poster_evidence='Friday Specials';}],
  ];
  for(const [name,edit] of refused) assert.equal(join(edit).length,5,name);
});

test('a refused join still publishes when the separate offers fit four slots, and holds when they do not',()=>{
  const apart=route([morning(),night(p=>{p.offers=[p.offers[1],p.offers[0],p.offers[2],p.offers[3],p.offers[4]];})]);
  assert.deepEqual(items(apart,'nightly'),['Chicken Stir Fry $12.99',NIGHTLY[0],'Steak Stir Fry $13.99',NIGHTLY[2]]);
  const crowded=route([morning(),night(p=>{p.offers=[p.offers[1],p.offers[0],p.offers[2],p.offers[3],{...p.offers[3],content:'Prime Rib $24.99',evidence:'Prime Rib $24.99'},p.offers[4]];})]);
  assert.ok(!items(crowded,'nightly'));
});

test('printed other weekday or a non-Friday-Night heading does not use the Friday rule',()=>{
  assert.equal(route([morning(),night(p=>{p.day_evidence='Thursday';p.day_of_week=4;p.poster_evidence='Thursday Night Specials 5-10pm';})]).targets.some(t=>t.service==='nightly'),false);
  assert.ok(!items(route([morning(),night(p=>{p.poster_evidence='Tonight 5-10pm';p.offers.forEach(o=>o.service_evidence='');})]),'nightly'));
});

test('explicit night labels on every offer: identical All Day repeat still stays All Day, never duplicated at night',()=>{
  const r=route([morning(),night(p=>{p.poster_evidence='Specials';p.offers.forEach(o=>o.service_evidence='Nightly 5-10pm');})]);
  // No night heading, so no variant join: the stir fries stay separate and still fit.
  assert.deepEqual(items(r,'nightly'),[NIGHTLY[0],'Chicken Stir Fry $12.99','Steak Stir Fry $13.99',NIGHTLY[2]]);
  assert.ok(!items(r,'nightly').some(c=>/Grilled Ham/.test(c)));
});

test('Monday Nightly capacity stays two',()=>{
  const monday=stored({...nightRaw,day_of_week:1,day_evidence:'Monday',poster_evidence:'Monday Night Specials 5-10pm'});
  assert.ok(!route([monday],{day:1,existing:ALL_DAY.map(content=>({content}))}).targets.some(t=>t.service==='nightly'));
});

function setup(t) {
  const f=harness(t,{now:'2026-10-23T14:26:05.441Z',candidate:structuredClone(morningRaw)});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-19',week_end_date='2026-10-25' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'morning',created_time:'2026-10-23T09:24:45-05:00',updated_time:'2026-10-23T09:24:45-05:00'});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  const group=f.slots(5,'nightly')[0].group_id;
  // Production Friday Nightly: the unlocked recurring default without a price.
  f.sql("UPDATE special_slots SET content=?,origin='manual',manual_locked=0,last_auto_value=NULL WHERE group_id=? AND position=1",
    '1 or 2 Piece Fish with 3 Jumbo Shrimp, French Fries & Choice of Side Salad or Coleslaw',group);
  const post=(id,created,candidate,at)=>{
    f.state.now=Date.parse(at);f.state.candidate=structuredClone(candidate);
    f.state.posts.push({...f.state.posts[0],id,created_time:created,updated_time:created});
  };
  return {...f,group,
    addNight:()=>post('night','2026-10-23T15:00:53-05:00',nightRaw,'2026-10-23T20:02:14.635Z'),
    addBrewers:()=>post('brewers','2026-10-23T15:13:45-05:00',brewersRaw,'2026-10-23T20:15:08.911Z'),
    nightly:()=>f.slots(5,'nightly').map(s=>s.content)};
}

test('pipeline: morning, Friday Night and Brewers posts publish exactly the three Nightly specials, idempotently',async t=>{
  const f=setup(t);await f.run();
  const daytime=[...f.slots(5,'lunch'),...f.slots(5,'all-day')];
  assert.deepEqual(f.slots(5,'all-day').filter(s=>s.content).map(s=>s.content),ALL_DAY);
  f.addNight();await f.run();
  assert.deepEqual(f.nightly(),[...NIGHTLY,'']);
  for(const s of f.slots(5,'nightly').slice(0,3)) {assert.equal(s.origin,'automation');assert.equal(s.manual_locked,0);assert.equal(s.last_auto_value,s.content);}
  assert.deepEqual([...f.slots(5,'lunch'),...f.slots(5,'all-day')],daytime);
  f.addBrewers();await f.run();
  assert.deepEqual(f.nightly(),[...NIGHTLY,'']);
  assert.ok(!f.sql('SELECT content FROM special_slots').some(s=>/pulled pork sandwich/i.test(s.content??'')));
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),calls=f.state.aiCalls;
  const events=f.sql('SELECT count(*) n FROM special_import_events')[0].n;
  f.state.now+=30*60000;await f.run();
  assert.equal(f.state.aiCalls,calls);
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.equal(f.sql('SELECT count(*) n FROM special_import_events')[0].n,events);
});

test('pipeline: a staff-locked Friday Nightly slot stays; eligible slots still publish and the block is audited',async t=>{
  const f=setup(t);
  f.sql("UPDATE special_slots SET content='Staff: Lobster tail $29',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",f.group);
  await f.run();f.addNight();await f.run();
  assert.deepEqual(f.nightly(),[NIGHTLY[0],'Staff: Lobster tail $29',NIGHTLY[2],'']);
  assert.ok(f.sql("SELECT detail FROM special_import_events WHERE event_type='review'").some(e=>e.detail.includes('Protected or ineligible destination slot')));
});

test('pipeline: a Friday Night poster with five distinct specials holds; default and daytime values stay',async t=>{
  const f=setup(t);await f.run();
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  f.addNight();
  f.state.candidate.offers.splice(3,0,...['Prime Rib $24.99','Walleye Dinner $18.99'].map(content=>({...f.state.candidate.offers[1],content,evidence:content})));
  await f.run();
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.match(f.nightly()[0],/French Fries & Choice of Side Salad or Coleslaw$/);
  assert.ok(f.sql("SELECT detail FROM special_import_events WHERE event_type='review'").some(e=>e.detail.includes('GUARDED_AUTO_CONFLICT')));
});

test('pipeline: a staff-edited All Day price is never overwritten by the night variant',async t=>{
  const f=setup(t);await f.run();
  const allDay=f.slots(5,'all-day')[0].group_id;
  f.sql("UPDATE special_slots SET content='Cheeseburger or Fish Sandwich w/ Side Salad, Soup or Coleslaw $10.50',manual_locked=1,origin='manual' WHERE group_id=? AND position=1",allDay);
  f.addNight();await f.run();
  assert.equal(f.slots(5,'all-day')[0].content,'Cheeseburger or Fish Sandwich w/ Side Salad, Soup or Coleslaw $10.50');
  assert.equal(f.nightly()[2],NIGHTLY[2]);
});
