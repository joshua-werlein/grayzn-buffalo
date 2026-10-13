import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyzeDailyEvidence,normalizeEvidenceOffer,planDailyEvidence,normalizeWeeklyRange} from './evidence.js';
import {canonicalizeSlotContent} from './reconcile.js';
import {reconcilePosterEvidence} from './reconcile.js';
import {harness} from './test-fixture.js';
import {validateExtraction} from './worker.js';
const exact=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct12-monday.json',import.meta.url),'utf8'));
const offer=(content,service_time='All Day',evidence=content)=>({content,service_time,evidence});
const poster=offers=>({day_of_week:1,day_evidence:'Monday',poster_evidence:'Monday Specials',offers});
const run=p=>planDailyEvidence([p],1,{today:'2026-10-12',validateDay:()=>{},canonicalize:canonicalizeSlotContent});

test('October 12 prices in misplaced fields survive without inventing the missing connector',()=>{
  const p=structuredClone(exact);p.offers=p.offers.slice(0,2);
  const value=analyzeDailyEvidence(p);
  assert.ok(value.issues.every(i=>i.reason==='Service not established by evidence'));
  assert.match(value.offers[0].content,/\$9\.75$/);
  assert.match(value.offers[1].content,/\$10\.25$/);
  assert.equal(value.offers[0].evidence,exact.offers[0].evidence);
  assert.equal(value.offers[0].service_time,'11-1:30');
  assert.ok(analyzeDailyEvidence(exact).issues.some(i=>/ambiguous|alternative/i.test(i.reason)));
});
test('missing meaningful side choices cannot pass factual validation',()=>{
  const p=poster([offer('Burger w/ Coleslaw $10','All Day','Burger w/ Soup or Coleslaw $10')]);
  assert.throws(()=>normalizeEvidenceOffer(p.offers[0]),/evidence|fact|choice/i);
});
test('one explicitly labeled All Day offer does not require a second offer',()=>{
  assert.deepEqual(run(poster([offer('Burger $10')])).targets,[{day_of_week:1,service:'all-day',partial:true,items:[{position:1,content:'Burger $10'}]}]);
});
test('unlabeled three-offer structure does not itself establish service',()=>{
  const p=poster(['Burger $10','Fish $12','Salad $9'].map(s=>offer(s,'')));
  assert.deepEqual(run(p).targets,[]);
});

const reliable=offers=>({...poster(offers),evidence_version:2});
function setup(t,p= reliable([offer('Burger $10')]),strategy='conditional') {
  const f=harness(t,{now:'2026-10-12T16:00:00Z',candidate:p});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:strategy});
  Object.assign(f.state.posts[0],{created_time:'2026-10-12T14:00:00Z',updated_time:'2026-10-12T14:00:00Z'});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-12',week_end_date='2026-10-18' WHERE id=9000");
  return f;
}
for(const strategy of ['single','conditional','always']) test(`strategy ${strategy}: complete evidence, exact budget and duplicate processing`,async t=>{
  const f=setup(t,undefined,strategy);await f.run();
  assert.equal(f.state.aiCalls,strategy==='always'?2:1);
  assert.equal(f.slots(1,'all-day')[0].content,'Burger $10');
  const before=f.sql('SELECT * FROM special_collections ORDER BY id');
  await f.run();assert.equal(f.state.aiCalls,strategy==='always'?2:1);
  assert.deepEqual(f.sql('SELECT * FROM special_collections ORDER BY id'),before);
});
test('partial publication keeps invalid slot 1 and publishes verified slot 2 without shifting',async t=>{
  const f=setup(t,reliable([offer('Burger $10','All Day','Burger $11'),offer('Salad $9')]));
  f.sql("UPDATE special_slots SET content='Recurring first',origin='manual',manual_locked=0 WHERE group_id=? AND position=1",f.slots(1,'all-day')[0].group_id);
  await f.run();
  assert.equal(f.state.aiCalls,2);
  assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>s.content),['Recurring first','Salad $9']);
});
test('invalid independent All Day offer does not block verified lunch',async t=>{
  const f=setup(t,reliable([offer('Burger $10','All Day','Burger $11'),offer('Salad $9','Lunch')]));
  await f.run();assert.equal(f.slots(1,'lunch')[0].content,'Salad $9');
  assert.equal(f.slots(1,'all-day')[0].content,'');
});
test('staff locked slot survives new partial planner',async t=>{
  const f=setup(t,reliable([offer('Burger $10'),offer('Salad $9')]));
  const id=f.slots(1,'all-day')[0].group_id;
  f.sql("UPDATE special_slots SET content='Staff choice',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",id);
  await f.run();assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>s.content),['Staff choice','Salad $9']);
});
test('targeted repair uses original image and actual error, retains first response audit',async t=>{
  const f=setup(t,reliable([offer('Burger $10','All Day','Burger $11')]));
  const requests=[];
  f.env.AI.run=async (_model,request)=>{requests.push(request);return {response:JSON.stringify(requests.length===1?f.state.candidate:reliable([offer('Burger $11')]))};};
  await f.run();assert.equal(requests.length,2);
  assert.match(requests[1].messages[1].content[0].text,/Conflicting offer price/);
  assert.equal(requests[1].messages[1].content[1].image_url.url,requests[0].messages[1].content[1].image_url.url);
  assert.equal(f.slots(1,'all-day')[0].content,'Burger $11');
  assert.equal(f.sql("SELECT * FROM special_import_events WHERE detail LIKE '%evidence-v2-response%'").length,2);
});
test('always verification cannot vote away a price disagreement',async t=>{
  const f=setup(t,undefined,'always');let calls=0;
  f.env.AI.run=async()=>({response:JSON.stringify(reliable([offer(++calls===1?'Burger $10':'Burger $11')]))});
  await f.run();assert.equal(calls,2);assert.equal(f.slots(1,'all-day')[0].content,'');
  assert.match(f.imports()[0].validation_reason,/Conflicting image verification/);
});
test('daily budget one cannot be exceeded by conditional repair',async t=>{
  const f=setup(t,reliable([offer('Burger $10','All Day','Burger $11')]));f.env.SPECIALS_AI_DAILY_LIMIT='1';
  await f.run();await f.run();assert.equal(f.state.aiCalls,1);assert.equal(f.slots(1,'all-day')[0].content,'');
});
for(const value of ['$9.75-10.25','$9.750','-$9.75','$9.75 / $10.25','$9.75 99-99']) test(`new normalizer rejects ambiguous time price ${value}`,()=>{
  assert.throws(()=>normalizeEvidenceOffer(offer('Burger',value,'Burger $9.75')));
});
// The request selects the contract; the model never echoes a version (a shared
// version key trapped real daily posters in the mexican-night shape). Contract-2
// rules still govern: the response is analyzed per offer, never by the legacy validator.
test('contract 2 is enforced by the request and its rules, not by a model-echoed version',()=>{
  const r=validateExtraction(JSON.stringify(poster([offer('Burger $10'),offer('Fish','All Day')])),true,{weekday:1,today:'2026-10-12'});
  const candidate=JSON.parse(r.candidateJson);
  assert.equal(candidate.evidence_version,2);
  assert.deepEqual(candidate.issues.map(i=>[i.index,i.reason]),[[1,'Missing meal price']]);
  assert.equal(r.needsRepair,true);
});
test('conflicting current posts hold only affected service',()=>{
  const a=reliable([offer('Burger $10'),offer('Salad $9','Lunch')]),b=reliable([offer('Burger $11')]);
  const r=reconcilePosterEvidence([a,b],1,[],{today:'2026-10-12'});
  assert.deepEqual(r.targets.map(t=>t.service),['lunch']);
});
test('date in an offer cannot contradict heading/current date',()=>{
  const p=reliable([{...offer('Burger $10'),date_evidence:'October 13'}]);
  assert.deepEqual(reconcilePosterEvidence([p],1,[],{today:'2026-10-12'}).targets,[]);
});
test('no source mutation and normalization is idempotent',()=>{
  const p=structuredClone(exact),before=JSON.stringify(p);
  const a=analyzeDailyEvidence(p);assert.deepEqual(analyzeDailyEvidence(a),a);assert.equal(JSON.stringify(p),before);
});

for(const label of ['Soup:','Soups:','SOUPS —','Soups\n']) test(`standalone ${JSON.stringify(label)} independent of uncertain meal`,()=>{
  const r=run(poster([offer('Burger $10',''),offer(`${label} French Onion or Chili`,'')]));
  assert.deepEqual(r.targets.map(t=>t.items[0].content),['French Onion or Chili']);
});
// Neither poster prints a service label; the gated house layout supplies
// Lunch/Day Special + two All Day (approved fallback). Facts are never changed.
for(const file of ['oct10-saturday','oct11-sunday']) test(`${file} exact source facts retained; unlabeled meals routed only by the gated house layout`,()=>{
  const raw=JSON.parse(readFileSync(new URL(`../../tests/fixtures/${file}.json`,import.meta.url),'utf8'));
  const p=analyzeDailyEvidence(raw);
  assert.deepEqual(p.offers,raw.offers);
  assert.ok(p.issues.every(i=>i.reason==='Service not established by evidence'));
  const r=reconcilePosterEvidence([p],p.day_of_week,[],{today:file==='oct10-saturday'?'2026-10-10':'2026-10-11'});
  assert.equal(r.rejectedSources.length,0);
  assert.deepEqual(r.targets.map(t=>t.role??t.service),['lunch','all-day','soup']);
  assert.deepEqual(r.unresolvedTargets,[]);
});
test('whole-week heading date range survives optional empty/missing field',()=>{
  for(const date_range of [undefined,'',null]) assert.equal(normalizeWeeklyRange({poster_evidence:'WEEKLY LUNCH SPECIALS • OCT 12-16 • 11AM-1:30PM',date_range}).date_range,'10/12-10/16');
  assert.throws(()=>normalizeWeeklyRange({poster_evidence:'OCT 12-16',date_range:'10/5-10/9'}),/Conflicting/);
});
const DAY_LABELS=['','Monday –','TUES:','Wed.','Thursday\n','FRI 10/16 -'];
const weeklyV2=(entries,heading='Weekly Lunch Specials OCT 12-16')=>({type:'weekly-lunch',evidence_version:2,poster_evidence:heading,
  service_time:'11-1:30',entries:entries.map(([day,content,evidence=`${DAY_LABELS[day]} ${content}`])=>({day_of_week:day,content,evidence,uncertainties:[]}))});
test('version 2 weekly schedule retains existing weekly destination adapter',async t=>{
  // Verbatim row evidence carries each row's own weekday label in varied layouts.
  const p=weeklyV2([1,2,3,4,5].map(day=>[day,`Meal ${day} and a Drink`]));
  const f=setup(t,p);await f.run();
  for(const entry of p.entries) assert.equal(f.slots(entry.day_of_week,'lunch')[0].content,entry.content);
  assert.equal(JSON.parse(f.imports()[0].candidate_json).date_range,'10/12-10/16');
});
test('source call reservations cap transient recovery across runs',async t=>{
  const f=setup(t);f.env.AI.run=async()=>{f.state.aiCalls++;throw Error('503 temporarily unavailable');};
  for(let i=0;i<5;i++){await f.run();f.state.now+=31*60*1000;}
  assert.equal(f.state.aiCalls,3);
  assert.equal(f.sql("SELECT * FROM special_import_events WHERE event_type='extract'").length,3);
  assert.equal(f.slots(1,'all-day')[0].content,'');
});
test('always strategy cannot publish unverified first answer when budget is exhausted',async t=>{
  const f=setup(t,undefined,'always');f.env.SPECIALS_AI_DAILY_LIMIT='1';await f.run();
  assert.equal(f.state.aiCalls,1);assert.equal(f.slots(1,'all-day')[0].content,'');
});
test('provider repair cannot silently drop a malformed offer',async t=>{
  const f=setup(t,reliable([offer('Burger $10','All Day','Burger $11'),offer('Salad $9')]));let n=0;
  f.env.AI.run=async()=>({response:JSON.stringify(++n===1?f.state.candidate:reliable([offer('Salad $9')]))});
  await f.run();assert.ok(f.slots(1,'all-day').every(s=>!s.content));
});
test('bundled alternatives preserve labels, quantities, prices and OR',()=>{
  const text='Chicken Stir Fry $12.99 OR Steak Stir Fry $13.99';
  assert.equal(normalizeEvidenceOffer(offer(text)).content,text);
  assert.throws(()=>normalizeEvidenceOffer(offer(text.replace(' OR ',' AND '),'All Day',text)),/facts/);
});
test('a service exceeding capacity never truncates offers to fit',()=>{
  assert.deepEqual(run(poster(['Burger $10','Salad $9','Fish $12'].map(s=>offer(s)))).targets,[]);
});
test('oversized faithful content is held, never truncated',()=>{
  const content='Burger with '+ 'extra vegetables '.repeat(10)+'$10';
  assert.throws(()=>normalizeEvidenceOffer(offer(content)),/150/);
});
test('current-day mismatch is diagnosed before deciding conditional recovery',()=>{
  const p=reliable([offer('Burger $10')]);p.day_of_week=0;
  assert.match(validateExtraction(JSON.stringify(p),true,{weekday:1,today:'2026-10-12'}).validationReason,/weekday|numeric day/i);
});
test('concurrent staff edit invalidates entire new partial publication snapshot',async t=>{
  const f=setup(t,reliable([offer('Burger $10'),offer('Salad $9')]));
  const batch=f.env.DB.batch.bind(f.env.DB);let injected=false;
  f.env.DB.batch=async statements=>{
    if(!injected && statements.some(s=>s.sql.includes('UPDATE special_collections SET revision=revision+1,mutation_token'))) {
      injected=true;
      f.sql("UPDATE special_slots SET content='Staff wins',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",f.slots(1,'all-day')[0].group_id);
    }
    return batch(statements);
  };
  await f.run();assert.equal(injected,true);
  assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>s.content),['Staff wins','']);
  await f.run();assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>s.content),['Staff wins','Salad $9']);
  assert.equal(f.state.aiCalls,1);
});
test('conflicting weekly sources leave conflicting lunch default, publish other verified day',async t=>{
  const weekly=content=>weeklyV2([[1,content],[2,'Tacos and a Drink']]);
  const f=setup(t,weekly('Burger and a Drink'));f.env.SPECIALS_IMPORT_MODE='DRY_RUN';await f.run();
  f.state.posts.push({...f.state.posts[0],id:'second'});f.state.candidate=weekly('Fish and a Drink');await f.run();
  f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';await f.run();
  assert.equal(f.slots(1,'lunch')[0].content,'');assert.equal(f.slots(2,'lunch')[0].content,'Tacos and a Drink');
});
test('version 2 preserves Mexican Night replacement and manual collection protection',async t=>{
  const p={type:'mexican-night',evidence_version:2,poster_evidence:'Mexican Night',schedule:'Tuesdays 5-10 PM',groups:[{label:'Entrees',
    items:[{title:'Burrito $9',description:'Meat and refried beans',evidence:'BURRITO .... $9\nMeat and refried beans',uncertainties:[]}]}]};
  const f=setup(t,p);f.state.now=Date.parse('2026-10-13T16:00:00Z');
  Object.assign(f.state.posts[0],{created_time:'2026-10-13T14:00:00Z',updated_time:'2026-10-13T14:00:00Z'});
  await f.run();
  assert.ok(f.sql("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night'").some(s=>s.content==='Burrito $9\nMeat and refried beans'));
  f.sql("UPDATE special_collections SET section_source='manual' WHERE id='mexican-night'");
  f.state.posts.push({...f.state.posts[0],id:'new-menu'});
  f.state.candidate={...p,groups:[{label:'Entrees',items:[{title:'Taco $5',description:'',evidence:'Taco $5',uncertainties:[]}]}]};await f.run();
  // The second menu validated; only the manual-collection protection withheld it.
  assert.equal(f.imports().find(i=>i.fb_post_id==='new-menu').validation_result,'ok');
  assert.ok(!f.sql("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night'").some(s=>s.content==='Taco $5'));
});
