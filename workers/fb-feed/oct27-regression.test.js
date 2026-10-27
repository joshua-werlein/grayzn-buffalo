import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateExtraction} from './worker.js';
import {reconcilePosterEvidence,canonicalizeSlotContent} from './reconcile.js';
import {normalizeMexicanSizeItem,trailingDailyPrice} from './evidence.js';
import {reconcileToday} from './guarded-auto.js';
import {harness} from './test-fixture.js';
import {formatAlertText,dailyAlertDetail} from './alert-detail.js';
const fixture=JSON.parse(readFileSync('tests/fixtures/oct27-production.json','utf8'));
const window={today:'2026-10-27',weekday:2};
const reliableDaily=()=>({...structuredClone(fixture.daily),evidence_version:2,offers:fixture.daily.offers.map(o=>({...o,uncertainties:[]}))});

test('original daily readings retain the precise two uncertainties and block the All Day destinations',()=>{
  const result=validateExtraction(JSON.stringify(fixture.daily),true,window);
  const raw=JSON.parse(result.candidateJson);
  assert.deepEqual(raw.issues.map(i=>i.index),[1,2]);
  const plan=reconcilePosterEvidence([raw],2,[],{today:window.today});
  assert.equal(plan.targets[0].service,'lunch');assert.equal(plan.unresolvedTargets.length,2);
  assert.ok(plan.unresolvedTargets.every(t=>t.reason==='Uncertain extracted offer'));
});
test('reliable complete Tuesday evidence establishes all three destinations and trailing meal prices',()=>{
  const plan=reconcilePosterEvidence([reliableDaily()],2,[],{today:window.today});
  assert.deepEqual(plan.targets.map(t=>t.service),['lunch','all-day']);
  assert.deepEqual(plan.targets.flatMap(t=>t.items.map(i=>i.content)),[
    'Gyro Sandwich with Beer Fries & a Drink $9.75',
    'Bacon Cheeseburger with Side Salad, Soup or Coleslaw $10.25',
    'Grilled Ham and Cheese with a Cup of Soup or Coleslaw $7.25']);
});
for(const content of ['$9.75 Gyro Sandwich with Beer Fries & a Drink','Gyro Sandwich $9.75 with Beer Fries & a Drink','Gyro Sandwich with Beer Fries & a Drink $9.75']) test(`price placement is lossless and idempotent: ${content}`,()=>{
  const result=canonicalizeSlotContent(content,2,'lunch');
  assert.equal(result,'Gyro Sandwich with Beer Fries & a Drink $9.75');assert.equal(canonicalizeSlotContent(result,2,'lunch'),result);
});
test('multi-price portions, choices, malformed and add-on prices never move under the daily rule',()=>{
  for(const content of ['Large Pizza $12 / Small Pizza $9','Burger $10 or Fish $12','Burger $9.750 with Fries','Burger $9.75-10.25','Burger with Extra Cheese $1.50'])
    assert.equal(trailingDailyPrice(content),content);
});
test('the repaired original Mexican reading validates without losing any of the twelve food/accessory entries',()=>{
  const first=fixture.readings.find(r=>r.kind==='mexican' && r.attempt===0);
  assert.equal(validateExtraction(JSON.stringify(first.raw),true,window).validationResult,'rejected','first reading omitted description evidence and still requires an image reread');
  for(const {raw} of fixture.readings.filter(r=>r.kind==='mexican' && r.attempt===1)) {
    const original=JSON.stringify(raw);
    const result=validateExtraction(original,true,window);
    assert.equal(result.validationResult,'ok',result.validationReason);
    const items=JSON.parse(result.candidateJson).groups.flatMap(g=>g.items);
    assert.equal(items.length,12);
    const salad=items.find(i=>i.title.startsWith('Taco Salad'));
    assert.equal(salad.title,'Taco Salad ... Large $9.00 | Small $8.50 | Mini $6.00');
    assert.equal(salad.description,'Meat, shredded cheese, lettuce, onion, tomato, and black olives served in a shell bowl');
    assert.equal(items.find(i=>i.title.startsWith('Burrito')).description,raw.groups[0].items[2].description);
    assert.equal(JSON.stringify(raw),original);
    assert.deepEqual(normalizeMexicanSizeItem(normalizeMexicanSizeItem(raw.groups[1].items[1])),normalizeMexicanSizeItem(raw.groups[1].items[1]));
  }
});
test('Mexican uncertainty and swapped size prices remain held with a targeted complete-menu reread',()=>{
  for(const mutate of [m=>m.groups[0].items[0].uncertainties=['Unreadable amount'],m=>m.groups[1].items[1].title='Taco Salad Large $8.50 | Small $9.00 | Mini $6.00']) {
    const m=structuredClone(fixture.mexican);mutate(m);
    const result=validateExtraction(JSON.stringify(m),true,window);
    assert.equal(result.validationResult,'rejected');assert.equal(result.repairShape,'mexican-night');
  }
});
test('unlocked different recurring defaults are replaced, manual corrections and unrelated slots survive, repeated scans are idempotent',async t=>{
  const candidate=reliableDaily();const f=harness(t,{now:'2026-10-27T16:00:00Z',candidate});
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  f.sql("UPDATE special_slots SET content='Different recurring meal $8',origin='manual',manual_locked=0 WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=2) AND position=1");
  const group=f.slots(2,'all-day')[0].group_id;
  f.sql("UPDATE special_slots SET content='Staff correction $7.25',manual_locked=1,origin='manual' WHERE group_id=? AND position=2",group);
  f.sql("INSERT INTO special_imports(id,fb_post_id,fb_created_time,parser_version,image_r2_key,candidate_json,processing_status,validation_result) VALUES('daily','daily','2026-10-27T15:04:39+0000',19,'test.jpg',?,'staged','ok')",JSON.stringify(candidate));
  const unrelated=f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='auto-week' AND g.day_of_week<>2");
  await reconcileToday(f.env,{sourceIds:['daily'],...window});
  assert.equal(f.slots(2,'all-day')[0].content,'Bacon Cheeseburger with Side Salad, Soup or Coleslaw $10.25');
  assert.equal(f.slots(2,'all-day')[1].content,'Staff correction $7.25');
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');await reconcileToday(f.env,{sourceIds:['daily'],...window});
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.deepEqual(f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='auto-week' AND g.day_of_week<>2"),unrelated);
});
test('alert includes authenticated review entry links without tokens',()=>{
  const detail=dailyAlertDetail({blocked:[{service:'all-day',reason:'Uncertain extracted offer'}]},[[{id:'daily',review_status:'pending'}]],'2026-10-27',2);
  const body=formatAlertText({day:'2026-10-27',code:'publication_blocked',summary:'Held',detail});
  assert.match(body,/admin\/automation\?date=2026-10-27#import-daily/);
  assert.doesNotMatch(body,/token=|secret=/);
});
test('original Mexican image readings use one focused repair and publish all current prices atomically from recurring defaults',async t=>{
  const readings=fixture.readings.filter(r=>r.kind==='mexican').map(r=>r.raw);
  const f=harness(t,{now:'2026-10-27T21:00:00Z',caption:'Mexican Night',candidate:readings[0]});
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  Object.assign(f.state.posts[0],{created_time:'2026-10-27T20:44:38+0000',updated_time:'2026-10-27T20:44:38+0000'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  const requests=[];t.mock.method(f.env.AI,'run',async(_model,request)=>{requests.push(request);return {response:JSON.stringify(readings[Math.min(requests.length-1,1)])};});
  await f.run();
  assert.equal(requests.length,2);assert.equal(requests[1].response_format.json_schema.schema.properties.type.const,'mexican-night');
  const source=f.imports()[0];assert.equal(source.validation_result,'ok');
  const contents=f.sql("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night' AND s.content<>'' ORDER BY g.sort,s.position").map(s=>s.content);
  const normalized=JSON.parse(validateExtraction(JSON.stringify(readings[1]),true,window).candidateJson);
  for(const item of normalized.groups.flatMap(g=>g.items)) {
    const expected=item.title.replace(/50c/g,'$0.50');
    assert.ok(contents.some(c=>c.startsWith(expected)),expected);
  }
  assert.equal(f.sql("SELECT * FROM special_import_events WHERE import_id=? AND detail LIKE 'GUARDED_AUTO:%'",source.id).length,0);
  const saved=f.sql("SELECT * FROM special_collections WHERE id='mexican-night'")[0];assert.equal(saved.section_source,'facebook');
  await f.run();assert.equal(requests.length,2);
  assert.deepEqual(f.sql("SELECT * FROM special_collections WHERE id='mexican-night'")[0],saved);
});
