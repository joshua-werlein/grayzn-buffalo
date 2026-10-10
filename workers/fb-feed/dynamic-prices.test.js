import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalizeSlotContent,reconcilePosterEvidence} from './reconcile.js';
import {harness,offer,poster} from './test-fixture.js';
import {loadTs} from '../../tests/load-ts.mjs';
import {PARSER_VERSION} from './classify.js';
const {displayedSpecial}=loadTs('src/lib/specials-store.ts');

const pizza=(content)=>poster(4,'Thursday Night Specials 5-10 PM',[offer(content,'','5-10 PM')]);
const setup=(t,day,candidate)=>{
  const date=day===4?'2030-01-10':'2030-01-11';
  const f=harness(t,{now:`${date}T23:00:00Z`,caption:'',candidate});
  Object.assign(f.state.posts[0],{created_time:`${date}T14:00:00Z`,updated_time:`${date}T14:00:00Z`});
  return f;
};
const pair=[offer('Garden Burger with Side Salad $10.25'),offer('Salad Sandwich with Soup $7.25')];
const dayPoster=()=>poster(5,'Friday Lunch Specials',[offer('Lunch Wrap and Drink $9.75','','11-1:30'),...pair]);
const nightPoster=(chicken,steak)=>poster(5,'Friday Night Specials 5-10 PM',[
  offer('1 or 2 Piece Fish with Shrimp and Sides $12.99/$13.99','','5-10 PM'),
  offer(`Chicken Stir Fry ${chicken}`),offer(`Steak Stir Fry ${steak}`),...pair,
]);

for (const [raw,expected] of [
  ['12" 3-Topping Pizza $13.50 / 16" 3-Topping Pizza $16','12" 3-Topping Pizza $13.50\n16" 3-Topping Pizza $16'],
  ['12" 3-Topping Pizza $14.25 / 16" 3-Topping Pizza $17.50','12" 3-Topping Pizza $14.25\n16" 3-Topping Pizza $17.50'],
  ['10 inch BBQ Pizza with Bacon $14.25 OR 18 inch Garden Pizza with Olives $17.50','10 inch BBQ Pizza with Bacon $14.25\nOR 18 inch Garden Pizza with Olives $17.50'],
  ['3-Topping Pizza 12" $14.25 / 16" $17.50','3-Topping Pizza 12" $14.25\n16" $17.50'],
  ['Pizza with Sausage and Peppers $19.25','Pizza with Sausage and Peppers $19.25'],
]) test(`current pizza descriptions and prices survive extraction, reconciliation, D1 and display: ${raw}`,async t=>{
  const candidate=pizza(raw),f=setup(t,4,candidate);await f.run();
  assert.deepEqual(JSON.parse(f.imports()[0].extracted_json),candidate);
  assert.equal(JSON.parse(f.imports()[0].candidate_json).offers[0].content,raw);
  assert.equal(f.slots(4,'nightly')[0].content,expected);
  assert.equal(f.slots(4,'nightly')[0].last_auto_value,expected);
  assert.equal(displayedSpecial(f.slots(4,'nightly')[0]),expected);
  assert.equal(f.slots(4,'nightly')[0].price,'');
  assert.equal(canonicalizeSlotContent(expected,4,'nightly'),expected);
  assert.equal(PARSER_VERSION,18);
});

for (const [chicken,steak] of [['$12.99','$13.99'],['$14.50','$16.25']])
  test(`Friday Nightly groups current choice prices ${chicken}/${steak} without moving them to All Day`,async t=>{
    const f=setup(t,5,dayPoster());await f.run();const established=f.slots(5,'all-day');
    const candidate=nightPoster(chicken,steak);
    f.state.posts.push({...f.state.posts[0],id:'night',created_time:'2030-01-11T21:00:00Z',updated_time:'2030-01-11T21:00:00Z'});
    f.state.candidate=candidate;await f.run();
    const expected=`Chicken Stir Fry ${chicken}\nOR Steak Stir Fry ${steak}`;
    assert.deepEqual(JSON.parse(f.imports().at(-1).extracted_json),candidate);
    assert.deepEqual(f.slots(5,'all-day'),established);
    assert.deepEqual(f.slots(5,'nightly').map(s=>s.content),[candidate.offers[0].content,expected,'','']);
    assert.equal(displayedSpecial(f.slots(5,'nightly')[1]),expected);
    assert.equal(f.state.aiCalls,2);
  });

for (const raw of [
  'Pizza with Sausage',
  '12" or 16" Pizza $14.25',
  '12" Pizza $14.25 / 16" Pizza',
  'Pizza $14.25/$17.50',
  '12" Pizza $14.2 / 16" Pizza $17.50',
  '12" Pizza $14.25 / 16" Pizza $17.500',
  'Chicken Stir Fry OR Steak Stir Fry $16.25',
  'Chicken Stir Fry $14.50/$16.25',
  'Chicken Stir Fry $14.50 OR Steak Stir Fry',
]) test(`missing or ambiguous choice prices stay unpublished and reviewable: ${raw}`,async t=>{
  const candidate=pizza(raw),result=reconcilePosterEvidence([candidate],4);
  assert.ok(!result.targets.some(g=>g.service==='nightly'));
  assert.ok(result.unresolvedTargets.some(t=>/printed choice prices/.test(t.reason)));
  const f=setup(t,4,candidate);await f.run();
  assert.ok(f.slots(4,'nightly').every(s=>s.content===''));
  assert.deepEqual(JSON.parse(f.imports()[0].extracted_json),candidate);
  assert.match(f.sql("SELECT detail FROM special_import_events WHERE event_type='review' ORDER BY id DESC")[0].detail,/printed choice prices/);
});

test('one printed pizza price never creates another size, description or historical amount',()=>{
  assert.equal(canonicalizeSlotContent('3-TOPPING PIZZA $14.25',4,'nightly'),'3-Topping Pizza $14.25');
  assert.equal(reconcilePosterEvidence([pizza('3-TOPPING PIZZA $14.25')],4).targets[0].items[0].content,'3-Topping Pizza $14.25');
});

test('Friday All Day formatting preserves actual prices instead of importing historical values',()=>{
  const raw='Chicken Stir Fry with Rice $14.50 / Steak Stir Fry with Noodles $16.25';
  const p=dayPoster();p.offers[1]=offer(raw);
  const expected='Chicken Stir Fry with Rice $14.50\nSteak Stir Fry with Noodles $16.25';
  assert.equal(reconcilePosterEvidence([p],5).targets.find(g=>g.service==='all-day').items[0].content,expected);
  assert.equal(canonicalizeSlotContent(raw,5,'all-day'),expected);
});

test('capitalization and whitespace preserve every printed size, choice and changed price',()=>{
  const raw='10 INCH BBQ PIZZA WITH BACON $14.25 / 18 INCH GARDEN PIZZA WITH OLIVES $17.50';
  assert.equal(canonicalizeSlotContent(raw,4,'nightly'),'10 Inch BBQ Pizza With Bacon $14.25\n18 Inch Garden Pizza With Olives $17.50');
  assert.equal(canonicalizeSlotContent('CHICKEN STIR FRY $14.50 / STEAK STIR FRY $16.25',5,'all-day'),
    'Chicken Stir Fry $14.50\nSteak Stir Fry $16.25');
});

for (const [name,origin,lock,baseline,expected] of [
  ['untouched recurring default','manual',0,null,'new'],
  ['confirmed staff correction','manual',1,null,'old'],
  ['unchanged automation','automation',0,'old','new'],
  ['edited automation','automation',0,'original','old'],
]) test(`dynamic pizza prices respect ownership: ${name}`,async t=>{
  const raw='10 inch BBQ Pizza $14.25 / 18 inch Garden Pizza $17.50',f=setup(t,4,pizza(raw));
  const id=f.slots(4,'nightly')[0].group_id;
  f.sql('UPDATE special_slots SET content=?,origin=?,manual_locked=?,last_auto_value=? WHERE group_id=? AND position=1','old',origin,lock,baseline,id);
  await f.run();assert.equal(f.slots(4,'nightly')[0].content,expected==='new'?'10 inch BBQ Pizza $14.25\n18 inch Garden Pizza $17.50':'old');
});

test('overlength changed-price offers are rejected without truncation or defaults',async t=>{
  const raw='Pizza with '+ 'Ingredients '.repeat(14)+'$14.25',f=setup(t,4,pizza(raw));
  await f.run();assert.equal(f.imports()[0].validation_result,'rejected');
  assert.ok(f.slots(4,'nightly').every(s=>s.content===''));
  assert.equal(JSON.parse(f.imports()[0].extracted_json).offers[0].content,raw);
});

test('an ambiguous All Day stir-fry does not suppress unrelated valid lunch',()=>{
  const p=dayPoster();p.offers[1]=offer('Chicken Stir Fry $14.50 OR Steak Stir Fry');
  const result=reconcilePosterEvidence([p],5);
  assert.ok(result.targets.some(g=>g.service==='lunch'));
  assert.ok(!result.targets.some(g=>g.service==='all-day'));
  assert.ok(result.unresolvedTargets.some(t=>t.service==='all-day' && /printed choice prices/.test(t.reason)));
});
