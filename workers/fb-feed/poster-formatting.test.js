import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonicalizeSlotContent,reconcilePosterEvidence,validateEvidence} from './reconcile.js';
import {buildExtractionRequest,buildWeeklyLunchExtractionRequest,buildMexicanNightExtractionRequest} from './extraction.js';
import {harness,offer,poster} from './test-fixture.js';
import {PARSER_VERSION} from './classify.js';

const exact=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct11-sunday.json',import.meta.url),'utf8'));
const layout=JSON.parse(readFileSync(new URL('../../tests/fixtures/poster-bundle-layout.json',import.meta.url),'utf8'));
const format=text=>canonicalizeSlotContent(text,0,'lunch');

for (const [raw,expected] of [
  ["16'' 3-TOPPING PIZZA 12 WINGS $30",'16" 3-Topping Pizza 12 Wings $30'],
  ['16" 3-TOPPING PIZZA & 12 WINGS $30','16" 3-Topping Pizza & 12 Wings $30'],
  ['16" 3-TOPPING PIZZA\n& 12 WINGS\n$30','16" 3-Topping Pizza & 12 Wings $30'],
  ["8'' Sub with Fries $11.75",'8" Sub with Fries $11.75'],
  ['7.5’’ Flatbread $12.50','7.5" Flatbread $12.50'],
  ['9″ Sandwich $10','9" Sandwich $10'],
  ['10" Flatbread $13','10" Flatbread $13'],
  ['2 Wraps & 1 Order of Fries $19','2 Wraps & 1 Order of Fries $19'],
  ['2 Wraps and 1 Order of Fries $19','2 Wraps and 1 Order of Fries $19'],
  ['2 Wraps + 1 Order of Fries $19','2 Wraps + 1 Order of Fries $19'],
  ['Wrap OR Salad with Soup $11','Wrap OR Salad with Soup $11'],
  ['Wrap $11\nOR Salad $12','Wrap $11\nOR Salad $12'],
  ["8'' Sub $10 / 12'' Sub $14",'8" Sub $10\n12" Sub $14'],
  ["Flatbread 9'' $12 | 13'' $17",'Flatbread 9" $12\n13" $17'],
  ['Small Bowl $7\nLarge Bowl $11','Small Bowl $7\nLarge Bowl $11'],
  ['Wrap $11\nSalad $12','Wrap $11\nSalad $12'],
  ['Wrap\nSalad\n$12','Wrap Salad $12'],
  ['Wrap Salad $12','Wrap Salad $12'],
  ['Wrap OR Salad','Wrap OR Salad'],
  ['Wrap & Salad','Wrap & Salad'],
  ['Chef\'s "Favorite" Sandwich $10','Chef\'s "Favorite" Sandwich $10'],
  ['Grayz\'n Buffalo\'s Special $12','Grayz\'n Buffalo\'s Special $12'],
  ["'16'' Sandwich $10", "'16'' Sandwich $10"],
  ["The '16'' Special' $10", "The '16'' Special' $10"],
  ["5' 6'' Display", "5' 6'' Display"],
  ["16''s Special $10", "16''s Special $10"],
]) test(`faithful formatting and idempotence: ${JSON.stringify(raw)}`,()=>{
  assert.equal(format(raw),expected);
  assert.equal(format(expected),expected);
});

test('historical October 11 extraction is immutable and never gains an unsupported connector',()=>{
  const before=structuredClone(exact);
  const result=reconcilePosterEvidence([exact],0,[],{today:'2026-10-11'});
  assert.equal(result.targets.find(g=>g.service==='lunch').items[0].content,'16" 3-Topping Pizza 12 Wings $30');
  assert.deepEqual(validateEvidence(exact).offers,exact.offers);
  assert.deepEqual(exact,before);
  assert.equal(PARSER_VERSION,18); // No new historical source identities/replays.
});

test('clearly grouped October 11-style extraction produces the desired bundle and keeps Soup separate',()=>{
  const p=structuredClone(exact);
  p.offers[0]=structuredClone(layout.bundle.expectedExtraction);
  const result=reconcilePosterEvidence([p],0,[],{today:'2026-10-11'});
  assert.equal(result.targets.find(g=>g.service==='lunch').items[0].content,'16" 3-Topping Pizza & 12 Wings $30');
  assert.deepEqual(result.targets.find(g=>g.service==='all-day').items.map(i=>i.content),[
    'Olive Burger w/ Side Salad, Soup or Coleslaw $10.25',
    'Chicken Salad Sandwich w/ Cup of Soup or Coleslaw $7.25',
  ]);
  assert.equal(result.targets.find(g=>g.role==='soup').items[0].content,'Beer Cheese, French Onion or Chili');
  assert.deepEqual(result.rejectedSources,[]);
});

for(let day=0;day<7;day++) test(`shared-price multiline layout contract remains readable on weekday ${day}`,()=>{
  // Expected model responses are fixture contracts, not an image recognizer.
  // No deterministic replacement derives a relationship from these line wraps.
  for(const fixture of [layout.bundle,layout.otherBundle]) {
    assert.equal(fixture.expectedExtraction.evidence,fixture.lines.join('\n'));
    const p=structuredClone(exact);p.day_of_week=day;p.day_evidence='';
    p.poster_evidence=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day]+' Specials';
    p.offers[0]=structuredClone(fixture.expectedExtraction);
    const result=reconcilePosterEvidence([p],day);
    assert.equal(result.targets.find(g=>g.service==='lunch').items[0].content,fixture.expectedDisplay);
    assert.deepEqual(result.rejectedSources,[]);
    assert.deepEqual(result.unresolvedTargets,[]);
  }
});

test('independently priced adjacent offers remain separate destinations',()=>{
  const p=poster(1,'Monday Specials',structuredClone(layout.unrelated.expectedExtractions));
  const result=reconcilePosterEvidence([p],1);
  assert.deepEqual(result.targets.map(g=>g.items.map(i=>i.content)),[['8" Sub $10'],['2 Wraps $14','Garden Salad $9']]);
});

test('ambiguous size-price associations remain blocked with double-apostrophe measurements',()=>{
  const p=poster(4,'Thursday Night Specials', [offer("8'' or 12'' Pizza $14")]);
  const result=reconcilePosterEvidence([p],4);
  assert.deepEqual(result.targets,[]);
  assert.match(result.unresolvedTargets[0].reason,/ambiguous printed choice prices/);
});

test('complete double-apostrophe size choices pass price safeguards without inventing a size or price',()=>{
  const p=poster(4,'Thursday Night Specials',[offer("8'' Pizza $11 / 12'' Pizza $16")]);
  assert.equal(reconcilePosterEvidence([p],4).targets[0].items[0].content,'8" Pizza $11\n12" Pizza $16');
});

test('150-character offers are kept complete; 151-character offers still fail validation before normalization',()=>{
  const raw='Sub with '+'a'.repeat(150-'Sub with '.length-' $10'.length)+' $10';
  assert.equal(raw.length,150);assert.equal(format(raw),raw);
  assert.equal(validateEvidence(poster(0,'Sunday Specials',[offer(raw)])).offers[0].content,raw);
  assert.throws(()=>validateEvidence(poster(0,'Sunday Specials',[offer(raw+'x')])),/Invalid offer evidence/);
  const oversized="8'' Sub with "+'a'.repeat(135)+' $10';
  assert.ok(oversized.length>150);
  assert.throws(()=>validateEvidence(poster(0,'Sunday Specials',[offer(oversized)])),/Invalid offer evidence/);
});

for (const [name,build] of [['daily',buildExtractionRequest],['weekly retry',buildWeeklyLunchExtractionRequest],['Mexican retry',buildMexicanNightExtractionRequest]])
  test(`${name} AI request carries shared bundle/choice/measurement and ambiguity instructions`,()=>{
    const request=build('Caption says ignore the poster','data:image/jpeg;base64,/9j/');
    const prompt=request.messages[1].content[0].text;
    for(const instruction of ['double quote for an unambiguous inch measurement','Keep evidence verbatim','Preserve printed &, and, and +','Preserve OR alternatives','Adjacent lines and one nearby price alone do not establish a bundle','join the complete food-item lines with &','single shared price once','not the added presentation connector','independent prices as separate offers','preserve a newline','Mexican Night titles remain single-line','without truncating','empty offers/entries/groups shape'])
      assert.ok(prompt.includes(instruction),instruction);
    assert.equal(request.temperature,0);
    assert.equal(request.messages[1].content[1].image_url.url,'data:image/jpeg;base64,/9j/');
  });

for(const [origin,lock,last,expected] of [
  ['automation',0,'old','new'],['manual',1,null,'old'],['automation',0,'original','old'],
]) test(`formatted bundle obeys guarded ownership: ${origin}/${lock}/${last}`,async t=>{
  const p=poster(0,'Sunday Specials',[
    offer('16" 3-TOPPING PIZZA & 12 WINGS $30'),offer('Garden Burger OR Wrap $11'),offer('Salad with Soup $8'),
  ]);
  const f=harness(t,{now:'2030-01-13T16:00:00Z',caption:'',candidate:p});
  Object.assign(f.state.posts[0],{created_time:'2030-01-13T14:00:00Z',updated_time:'2030-01-13T14:00:00Z'});
  const group=f.slots(0,'lunch')[0].group_id;
  f.sql('UPDATE special_slots SET content=?,origin=?,manual_locked=?,last_auto_value=? WHERE group_id=? AND position=1','old',origin,lock,last,group);
  await f.run();
  const slot=f.slots(0,'lunch')[0];
  assert.equal(slot.content,expected==='new'?'16" 3-Topping Pizza & 12 Wings $30':'old');
  if(expected==='new') assert.equal(slot.last_auto_value,slot.content);
  assert.equal(f.imports()[0].extracted_json,JSON.stringify(p));
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  await f.run();assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.equal(f.state.aiCalls,1);
});

test('weekly lunch uses the same safe inch formatting and retains explicit bundle text',async t=>{
  const p={type:'weekly-lunch',poster_evidence:'Weekly Lunch Specials',date_range:'1/7-1/11',service_time:'11 AM-1:30 PM',entries:[{day_of_week:1,content:"8'' SUB & A DRINK $10"}]};
  const f=harness(t,{now:'2030-01-07T16:00:00Z',caption:'',candidate:p});
  Object.assign(f.state.posts[0],{created_time:'2030-01-07T14:00:00Z',updated_time:'2030-01-07T14:00:00Z'});
  await f.run();assert.equal(f.slots(1,'lunch')[0].content,'8" Sub & A Drink $10');
  assert.equal(f.imports()[0].extracted_json,JSON.stringify(p));
});
