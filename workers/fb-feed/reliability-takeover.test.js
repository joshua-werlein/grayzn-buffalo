// Contract-2 regressions added when completing the reliability redesign:
// protected-slot ordering, other-day exclusion, repair-call fallback,
// weekly/Mexican Night fact checks and the October 12 end-to-end path.
// All AI responses are mocked; none of these tests evaluates a real image.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planDailyEvidence} from './evidence.js';
import {canonicalizeSlotContent} from './reconcile.js';
import {harness} from './test-fixture.js';
import {validateExtraction} from './worker.js';

const exact=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct12-monday.json',import.meta.url),'utf8'));
const offer=(content,service_time='All Day',evidence=content)=>({content,service_time,evidence});
const reliable=offers=>({day_of_week:1,day_evidence:'Monday',poster_evidence:'Monday Specials',offers,evidence_version:2});
function setup(t,p=reliable([offer('Burger $10')]),strategy='conditional') {
  const f=harness(t,{now:'2026-10-12T16:00:00Z',candidate:p});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:strategy});
  Object.assign(f.state.posts[0],{created_time:'2026-10-12T14:00:00Z',updated_time:'2026-10-12T14:00:00Z'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-12',week_end_date='2026-10-18' WHERE id=9000");
  return f;
}
// The harness returns one candidate for every post; choose responses by caption instead.
function byCaption(f,responses) {
  f.env.AI.run=async(_model,request)=>{
    f.state.aiCalls++;
    const text=request.messages[1].content[0].text;
    const key=Object.keys(responses).find(k=>text.includes(k));
    return {response:JSON.stringify(responses[key])};
  };
}
function secondPost(f,id,message) {
  f.state.posts[0].message='CAPTION-7F3-TODAY';
  f.state.posts.push({...f.state.posts[0],id,message,created_time:'2026-10-12T14:30:00Z',updated_time:'2026-10-12T14:30:00Z'});
}

// ── Protected-slot ordering ──
const plan=(offers,slotLayout,weekday=1)=>planDailyEvidence([reliable(offers)],weekday,
  {today:'2026-10-12',validateDay:()=>{},canonicalize:canonicalizeSlotContent,slotLayout});
const layout=(...contents)=>contents.map((content,i)=>({service:'all-day',position:i+1,content}));
const placed=r=>r.targets.flatMap(t=>t.items.map(i=>[t.service,i.position,i.content]));

test('an offer already held by a slot keeps it; the other offer takes the free slot instead of holding the service',()=>{
  assert.deepEqual(placed(plan([offer('Burger $10'),offer('Salad $9')],layout('Salad $9',''))),
    [['all-day',2,'Burger $10'],['all-day',1,'Salad $9']]);
  assert.deepEqual(placed(plan([offer('Burger $10'),offer('Salad $9')],layout('','Burger $10'))),
    [['all-day',2,'Burger $10'],['all-day',1,'Salad $9']]);
});
test('identity anchors ignore price, so an edited price stays in its published slot',()=>{
  assert.deepEqual(placed(plan([offer('Salad $9'),offer('Burger $11')],layout('Burger $10','Salad $9'))),
    [['all-day',2,'Salad $9'],['all-day',1,'Burger $11']]);
});
test('a displaced offer never takes the slot reserved by an unresolved offer',()=>{
  // Offer 1 is unresolved (no price) and reserves slot 1; offer 2 wants slot 2,
  // which an anchor for offer 3 already holds. No legal slot remains: hold, never shift into slot 1.
  const r=plan([offer('Fish'),offer('Burger $10'),offer('Salad $9')],layout('','Salad $9'),5);
  assert.deepEqual(r.targets,[]);
  assert.ok(r.unresolvedTargets.some(u=>u.reason==='Missing meal price' && u.position===1));
});
test('without anchors, a valid offer keeps its printed slot beside an unresolved one',()=>{
  const r=plan([offer('Fish'),offer('Salad $9')],layout('Recurring',''));
  assert.deepEqual(placed(r),[['all-day',2,'Salad $9']]);
});
test('two offers anchored to the same slot remain ambiguous and are held',()=>{
  // Differing prices are distinct offers, but both share one dish identity and slot.
  assert.deepEqual(plan([offer('Burger $10'),offer('Burger $12')],layout('Burger $9','')).targets,[]);
});
test('integration: staff-locked slot 1 already holding offer 2 is untouched; offer 1 publishes to slot 2',async t=>{
  const f=setup(t,reliable([offer('Burger $10'),offer('Salad $9')]));
  const id=f.slots(1,'all-day')[0].group_id;
  f.sql("UPDATE special_slots SET content='Salad $9',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",id);
  await f.run();
  const [one,two]=f.slots(1,'all-day');
  assert.deepEqual([one.content,one.origin,one.manual_locked],['Salad $9','manual',1]);
  assert.deepEqual([two.content,two.origin,two.last_auto_value],['Burger $10','automation','Burger $10']);
});
test('integration: staff-locked slot holding an unrelated value is never overwritten by a displaced offer',async t=>{
  const f=setup(t,reliable([offer('Burger $10'),offer('Salad $9')]));
  const id=f.slots(1,'all-day')[0].group_id;
  f.sql("UPDATE special_slots SET content='Salad $9',origin='automation',manual_locked=0,last_auto_value='Salad $9' WHERE group_id=? AND position=1",id);
  f.sql("UPDATE special_slots SET content='Staff Fish $12',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",id);
  await f.run();
  assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>[s.content,s.manual_locked]),[['Salad $9',0],['Staff Fish $12',1]]);
});

// ── One post cannot block another unnecessarily ──
test('a post printed for another day is excluded, not allowed to block today',async t=>{
  const f=setup(t);secondPost(f,'teaser','CAPTION-7F3-TEASER');
  byCaption(f,{'CAPTION-7F3-TODAY':reliable([offer('Burger $10')]),
    'CAPTION-7F3-TEASER':{...reliable([offer('Tacos $8','5-10 PM')]),day_of_week:2,day_evidence:'Tuesday',poster_evidence:'Tuesday Night Specials'}});
  await f.run();
  assert.equal(f.slots(1,'all-day')[0].content,'Burger $10');
  const teaser=f.imports().find(i=>i.fb_post_id==='teaser');
  assert.equal(teaser.processing_status,'failed');
  assert.equal(teaser.validation_reason,'Printed weekday does not match current Chicago day');
});
test('a post with a printed other calendar date is excluded, not allowed to block today',async t=>{
  const f=setup(t);secondPost(f,'dated','CAPTION-7F3-DATED');
  byCaption(f,{'CAPTION-7F3-TODAY':reliable([offer('Burger $10')]),
    'CAPTION-7F3-DATED':{...reliable([offer('Prime Rib $20')]),day_of_week:-1,day_evidence:'',poster_evidence:'Specials 10/17'}});
  await f.run();
  assert.equal(f.slots(1,'all-day')[0].content,'Burger $10');
});
test('a self-contradictory post still blocks today (cannot prove it is unrelated)',async t=>{
  const f=setup(t);secondPost(f,'unclear','CAPTION-7F3-UNCLEAR');
  // Printed Monday contradicts numeric Thursday.
  byCaption(f,{'CAPTION-7F3-TODAY':reliable([offer('Burger $10')]),
    'CAPTION-7F3-UNCLEAR':{...reliable([offer('Salad $9')]),day_of_week:4,day_evidence:'Monday'}});
  await f.run();
  assert.equal(f.slots(1,'all-day')[0].content,'');
});

// ── Bounded recovery ──
test('a failed repair call keeps the first reading: verified offers still publish',async t=>{
  const f=setup(t,reliable([offer('Burger $10','All Day','Burger $11'),offer('Salad $9')]));let n=0;
  f.env.AI.run=async()=>{f.state.aiCalls++;if(++n===2) throw Error('503 temporarily unavailable');return {response:JSON.stringify(f.state.candidate)};};
  await f.run();
  assert.equal(f.state.aiCalls,2);
  assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>s.content),['','Salad $9']);
  assert.equal(f.imports()[0].processing_status,'staged');
  // Staged and finished: no further AI calls on later crons.
  await f.run();assert.equal(f.state.aiCalls,2);
});
test('always: a failed verification call publishes nothing',async t=>{
  const f=setup(t,undefined,'always');let n=0;
  f.env.AI.run=async()=>{f.state.aiCalls++;if(++n===2) throw Error('503 temporarily unavailable');return {response:JSON.stringify(f.state.candidate)};};
  await f.run();
  assert.equal(f.slots(1,'all-day')[0].content,'');
  assert.match(f.imports()[0].validation_reason,/Conflicting image verification/);
});

// ── Weekly and Mexican Night contract-2 fact checks ──
const weeklyV2=entries=>({type:'weekly-lunch',evidence_version:2,poster_evidence:'Weekly Lunch Specials OCT 12-16',service_time:'11-1:30',
  entries:entries.map(([day,content,evidence])=>({day_of_week:day,content,evidence,uncertainties:[]}))});
test("weekly: a row's own weekday label is layout; another weekday's label is a day-association error",()=>{
  const r=validateExtraction(JSON.stringify(weeklyV2([[1,'Caesar Salad & a Drink','MONDAY 10/12: Caesar Salad & a Drink'],
    [2,'Tacos & a Drink','Wednesday – Tacos & a Drink']])),true);
  assert.equal(r.validationResult,'ok');
  const candidate=JSON.parse(r.candidateJson);
  assert.deepEqual(candidate.entries.map(e=>e.day_of_week),[1]);
  assert.deepEqual(candidate.unresolved_days.map(d=>d.day),[2]);
  assert.equal(r.needsRepair,true);
});
const TUESDAY=[2,'Tacos & a Drink','Tuesday – Tacos & a Drink'];
test('weekly: a dropped side alternative is unresolved, never published',()=>{
  const r=validateExtraction(JSON.stringify(weeklyV2([[1,'Burger & Fries','Monday – Burger & Fries or Salad'],TUESDAY])),true);
  const candidate=JSON.parse(r.candidateJson);
  assert.deepEqual(candidate.entries.map(e=>e.day_of_week),[2]);
  assert.deepEqual(candidate.unresolved_days.map(d=>d.day),[1]);
});
test('weekly: when no day is verifiable, the whole source is rejected and nothing publishes',()=>{
  const r=validateExtraction(JSON.stringify(weeklyV2([[1,'Burger & Fries','Monday – Burger & Fries or Salad']])),true);
  assert.equal(r.validationResult,'rejected');
  assert.equal(r.candidateJson,null);
});
test('weekly: a word that merely starts like a weekday (Monterey) remains meal content',()=>{
  const r=validateExtraction(JSON.stringify(weeklyV2([[1,'Monterey Chicken & a Drink','Monterey Chicken & a Drink'],TUESDAY])),true);
  assert.deepEqual(JSON.parse(r.candidateJson).entries.map(e=>e.content),['Monterey Chicken & a Drink','Tacos & a Drink']);
  const dropped=validateExtraction(JSON.stringify(weeklyV2([[1,'Chicken & a Drink','Monterey Chicken & a Drink'],TUESDAY])),true);
  assert.deepEqual(JSON.parse(dropped.candidateJson).unresolved_days.map(d=>d.day),[1]);
});
const mexican=items=>({type:'mexican-night',evidence_version:2,poster_evidence:'Mexican Night',schedule:'',
  groups:[{label:'Entrees',items:items.map(([title,description,evidence])=>({title,description,evidence,uncertainties:[]}))}]});
const NACHOS='NACHOS\nChips, cheese & beef\nLarge $8.00  Small $6.00';
test('Mexican Night: size prices gathered into the title from a separate line are accepted',()=>{
  const r=validateExtraction(JSON.stringify(mexican([['Nachos Large $8.00 | Small $6.00','Chips, cheese & beef',NACHOS]])),true);
  assert.equal(r.validationResult,'ok');
});
test('Mexican Night: swapped size prices, dropped words or invented prices reject the whole menu',()=>{
  for(const [title,description] of [['Nachos Large $6.00 | Small $8.00','Chips, cheese & beef'],
    ['Nachos Large $8.00 | Small $6.00','Chips & cheese'],['Nachos Large $8.00 | Small $6.00 | Mini $4.00','Chips, cheese & beef']])
    assert.equal(validateExtraction(JSON.stringify(mexican([[title,description,NACHOS]])),true).validationResult,'rejected',title+' / '+description);
});

// ── October 12 end to end ──
test('October 12: priced lunch replaces the weekly reading, verified All Day publishes, ambiguous meal keeps its default',async t=>{
  // Production content/evidence/service_time strings verbatim; only service_evidence
  // (absent from the legacy contract) is added. Mocked reading, not an image evaluation.
  const [lunch,blt,chicken]=exact.offers;
  const reading={...exact,evidence_version:2,offers:[{...lunch,service_evidence:'Lunch 11-1:30'},
    {...blt,service_evidence:'All Day'},{...chicken,service_evidence:'All Day'}]};
  const f=setup(t,reading);
  const lunchGroup=f.slots(1,'lunch')[0].group_id,allDay=f.slots(1,'all-day')[0].group_id;
  // Production state at 9:12 AM: automation-owned weekly lunch text, recurring default in All Day 2.
  f.sql("UPDATE special_slots SET content='Grilled Chicken Caesar Salad & a Drink',origin='automation',manual_locked=0,last_auto_value='Grilled Chicken Caesar Salad & a Drink' WHERE group_id=? AND position=1",lunchGroup);
  f.sql("UPDATE special_slots SET content='Chicken Salad Sandwich with cup of Chili or Coleslaw',origin='manual',manual_locked=0 WHERE group_id=? AND position=2",allDay);
  await f.run();
  assert.equal(f.slots(1,'lunch')[0].content,'Grilled Chicken Caesar Salad and a Drink $9.75');
  assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>s.content),
    ['Cheddar BLT w/ Side Salad, Soup or Coleslaw $10.25','Chicken Salad Sandwich with cup of Chili or Coleslaw']);
  // Conditional strategy: one targeted repair for the ambiguous meal; the mock repeats the reading.
  assert.equal(f.state.aiCalls,2);
  // Silent fallback: nothing leaves the Worker except Graph and the image CDN.
  assert.deepEqual([...new Set(f.state.calls.map(u=>u.hostname))].sort(),['cdn.example','graph.facebook.com']);
  const revision=()=>f.sql("SELECT revision FROM special_collections WHERE id='auto-week'");
  const before=revision();
  await f.run();await f.run();
  assert.deepEqual(revision(),before);
  assert.equal(f.state.aiCalls,2);
});

// ── Structured-decoding shape trap (found by real-image evaluation, 2026-10-12) ──
// Workers AI emitted every key in sorted order. A key common to all shapes let the
// first token choose mexican-night for every daily poster. Guard the schema itself.
import {RELIABLE_EXTRACTION_SCHEMA,buildReliableExtractionRequest} from './extraction.js';
test("contract-2 schema: each shape's first sorted key belongs to no other shape",()=>{
  // Otherwise a model opening with that key, intending another shape, is locked into this one.
  const shapes=RELIABLE_EXTRACTION_SCHEMA.anyOf.map(shape=>Object.keys(shape.properties));
  shapes.forEach((keys,i)=>{
    const first=[...keys].sort()[0];
    assert.ok(shapes.every((other,j)=>j===i||!other.includes(first)),`shape ${i} opens with shared key ${first}`);
  });
});
test('contract-2 schema and prompt never ask the model for a contract version',()=>{
  assert.ok(RELIABLE_EXTRACTION_SCHEMA.anyOf.every(shape=>!('evidence_version' in shape.properties)));
  assert.doesNotMatch(buildReliableExtractionRequest('','data:image/jpeg;base64,AA').messages[1].content[0].text,/evidence_version/);
});
test('a sorted-key daily response without a version validates as contract-2 daily evidence',()=>{
  const sorted={day_evidence:'Monday',day_of_week:1,offers:[{content:'Burger $10',date_evidence:'',evidence:'Burger $10',
    service_evidence:'All Day',service_time:'',uncertainties:[]}],poster_evidence:'MONDAY SPECIALS'};
  const r=validateExtraction(JSON.stringify(sorted),true,{weekday:1,today:'2026-10-12'});
  assert.equal(r.validationResult,'ok');
  assert.equal(JSON.parse(r.candidateJson).evidence_version,2);
});
