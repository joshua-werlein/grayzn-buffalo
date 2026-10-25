import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateExtraction} from './worker.js';
import {reconcilePosterEvidence,singleDayLunchEvidenceV2} from './reconcile.js';
import {reconcileToday} from './guarded-auto.js';
import {harness} from './test-fixture.js';
import {observeDailyOutcome} from './alert-outcomes.js';
import {dispatchAlert,ALERT_GRACE_MS} from './alert-store.js';

const snapshot=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct21-production.json',import.meta.url),'utf8'));
const rows=snapshot[0].results;
const raw=i=>JSON.parse(rows[i].extracted_json);
const validate=p=>validateExtraction(JSON.stringify(p),true,{today:'2026-10-21',weekday:3});

function enableObservations(f) {
  const sql=readFileSync(new URL('../../migrations/0023_facebook_alert_incidents.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean)) f.sql(statement);
  f.env.SPECIALS_ALERT_MODE='OBSERVE';
}

test('October 21: current rejection opens daily incident; recovered historical failure resolves it and preserves one Lunch',async t=>{
  const f=setup(t);enableObservations(f);f.env.SPECIALS_IMPORT_MODE='DRY_RUN';await f.run();
  const bad=raw(0);bad.entries[1].content=bad.entries[1].content.replace('10.25','11.25');
  f.sql("UPDATE special_imports SET processing_status='failed',validation_result='rejected',candidate_json=NULL,extracted_json=?",JSON.stringify(bad));
  f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';await f.run();
  assert.equal(f.sql("SELECT state FROM facebook_alert_incidents WHERE scope='daily'")[0].state,'attention');
  // A retry beginning after the failure must pause the already queued incident.
  f.sql("UPDATE special_imports SET processing_status='pending'");f.state.now+=1000;
  const pending=await reconcileToday(f.env,{sourceIds:f.imports().map(s=>s.id),today:'2026-10-21',weekday:3});
  await observeDailyOutcome(f.env,pending,{day:'2026-10-21',observedAt:new Date(f.state.now).toISOString()});
  assert.equal(f.sql("SELECT state FROM facebook_alert_incidents WHERE scope='daily'")[0].state,'pending');
  f.state.now+=ALERT_GRACE_MS;
  assert.equal((await dispatchAlert(f.env.DB,async()=>assert.fail('retry pending'),{enabled:true,now:()=>f.state.now})).status,'idle');
  f.sql("UPDATE special_imports SET processing_status='failed'");
  f.sql('UPDATE special_imports SET extracted_json=?',JSON.stringify(raw(0)));f.state.now+=1000;await f.run();
  assert.equal(f.imports()[0].processing_status,'failed');
  assert.equal(f.sql("SELECT state FROM facebook_alert_incidents WHERE scope='daily'")[0].state,'resolved');
  assert.equal(f.slots(3,'lunch').filter(s=>s.content).length,1);
  assert.match(f.slots(3,'lunch')[0].content,/\$9.75/);
});

test('daily alert rejects an outcome superseded by a staff collection revision',async t=>{
  const f=setup(t);enableObservations(f);f.env.SPECIALS_IMPORT_MODE='DRY_RUN';await f.run();
  const r=await reconcileToday(f.env,{sourceIds:f.imports().map(s=>s.id),today:'2026-10-21',weekday:3});
  assert.ok(r.alertSnapshot);
  f.sql('UPDATE special_collections SET revision=revision+1 WHERE id=?',r.alertSnapshot.collectionId);
  await observeDailyOutcome(f.env,r,{day:'2026-10-21',observedAt:new Date(f.state.now).toISOString()});
  assert.equal(f.sql('SELECT * FROM facebook_alert_incidents').length,0);
});

for(const choice of ['disabled','locked']) test(`daily observation respects staff ${choice} Lunch without an actionable incident`,async t=>{
  const f=setup(t);enableObservations(f);
  const group=f.slots(3,'lunch')[0].group_id;
  if(choice==='disabled') f.sql('UPDATE special_groups SET enabled=0 WHERE id=?',group);
  else f.sql("UPDATE special_slots SET content='Staff lunch',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",group);
  await f.run();
  assert.equal(f.sql("SELECT state FROM facebook_alert_incidents WHERE scope='daily'").length,0);
  if(choice==='locked') assert.equal(f.slots(3,'lunch')[0].content,'Staff lunch');
});
test('production confirms discovery, complete extraction, global rejection and unlocked defaults',()=>{
  assert.ok(snapshot.every(s=>s.success && s.meta.rows_written===0));
  assert.equal(raw(0).entries.length,4);
  assert.equal(rows[0].validation_reason,'Invalid or duplicate weekly weekday evidence');
  assert.equal(rows[1].processing_status,'staged');
  assert.ok(snapshot[2].results.some(e=>e.import_id===rows[1].id && e.detail.includes('1 rejected source')));
  const live=snapshot[1].results.filter(s=>s.collection_id!=='defaults' && s.content);
  assert.ok(live.every(s=>s.manual_locked===0));
  assert.ok(live.find(s=>s.service==='nightly').content.includes('Add Fries'));
});
test('single-day shape recovery preserves original evidence and all offers before weekly uniqueness validation',()=>{
  const p=raw(0),before=JSON.stringify(p),v=validate(p);
  assert.equal(v.validationResult,'ok');assert.equal(v.needsRepair,false);
  const c=JSON.parse(v.candidateJson);
  assert.equal(c.offers.length,4);
  c.offers.forEach((o,i)=>assert.equal(o.evidence,p.entries[i].evidence));
  assert.equal(JSON.stringify(p),before);
});
test('both original poster shapes reconcile with source prices under the existing approved house layout',()=>{
  for(const candidates of [[raw(0)],[raw(0),{...raw(1),evidence_version:2}],[{...raw(1),evidence_version:2},raw(0)]]) {
    const r=reconcilePosterEvidence(candidates,3,[],{today:'2026-10-21'});
    assert.deepEqual(r.rejectedSources,[]);assert.deepEqual(r.unresolvedTargets,[]);
    const text=r.targets.flatMap(t=>t.items).map(i=>i.content).join('\n');
    for(const price of ['$9.75','$10.25','$7.25']) assert.ok(text.includes(price));
    if(candidates.length===2) {assert.match(text,/0\.89|\.89/);assert.match(text,/0\.99|\.99/);}
  }
});
for(const [name,change] of [
  ['weekly heading',p=>p.poster_evidence='Weekly Lunch Specials'],
  ['date range',p=>p.date_range='10/19-10/23'],
  ['mixed weekdays',p=>p.entries[1].day_of_week=4],
]) test(`shape recovery does not reinterpret ${name}`,()=>{
  const p=raw(0);change(p);assert.equal(singleDayLunchEvidenceV2(p),null);
  assert.equal(validate(p).validationResult,'rejected');
});
for(const [name,change] of [
  ['missing evidence',p=>delete p.entries[1].evidence],
  ['changed price',p=>p.entries[1].content=p.entries[1].content.replace('10.25','11.25')],
  ['uncertain meal',p=>p.entries[1].uncertainties=['Unreadable price']],
  ['overlong meal',p=>p.entries[1].content+='x'.repeat(151)],
]) test(`recovered ${name} stays held`,()=>{
  const p=raw(0);change(p);const v=validate(p);
  assert.ok(v.needsRepair);
  const r=reconcilePosterEvidence([JSON.parse(v.candidateJson)],3,[],{today:'2026-10-21'});
  assert.ok(r.unresolvedTargets.length);
  assert.ok(!r.targets.flatMap(t=>t.items).some(i=>i.content.startsWith('Pizza Burger')));
});
test('three genuinely timed lunch meals remain a capacity conflict, never relabeled to fit',()=>{
  const p=raw(0);p.entries.slice(0,3).forEach(e=>{e.evidence+=' Lunch 11-1:30';e.service_time='11-1:30';});
  const r=reconcilePosterEvidence([singleDayLunchEvidenceV2(p)],3,[],{today:'2026-10-21'});
  assert.ok(r.unresolvedTargets.some(t=>t.reason==='Destination capacity exceeded'));
  assert.ok(!r.targets.some(t=>t.service==='all-day'));
});
test('shape adapter is weekday-independent and keeps date contradictions closed',()=>{
  for(const [day,name] of ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].entries()) {
    const p=raw(0);p.poster_evidence=`${name} Lunch Specials`;p.entries.forEach(e=>e.day_of_week=day);
    const daily=singleDayLunchEvidenceV2(p);assert.equal(daily.day_of_week,day);
    const v=validateExtraction(JSON.stringify(p),true,{today:'2026-10-21',weekday:3});
    assert.equal(v.validationResult,day===3?'ok':'rejected');
  }
  const p=raw(0);p.entries[1].date_evidence='tomorrow';
  const r=reconcilePosterEvidence([singleDayLunchEvidenceV2(p)],3,[],{today:'2026-10-21'});
  assert.equal(r.targets.length,0);assert.ok(r.rejectedSources.length);
});
test('malformed alternate shapes cannot crash reconciliation',()=>{
  for(const entries of ['bad',[null],['bad'],{}]) {
    const p={type:'weekly-lunch',entries};
    assert.doesNotThrow(()=>reconcilePosterEvidence([p,{...raw(1),evidence_version:2}],3,[],{today:'2026-10-21'}));
  }
});
function setup(t) {
  const f=harness(t,{now:'2026-10-21T21:00:00Z',candidate:raw(0)});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  Object.assign(f.state.posts[0],{created_time:rows[0].fb_created_time,updated_time:rows[0].fb_created_time});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-19',week_end_date='2026-10-25' WHERE id=9000");
  for(const s of snapshot[1].results.filter(s=>s.collection_id!=='defaults' && s.service!=='custom')) {
    const group=f.slots(3,s.service)[0].group_id;
    f.sql('UPDATE special_slots SET content=?,origin=?,manual_locked=?,last_auto_value=? WHERE group_id=? AND position=?',s.content,s.origin,s.manual_locked,s.last_auto_value,group,s.position);
  }
  return f;
}
test('new import replaces unlocked defaults, publishes prices, and repeat scan uses no additional AI',async t=>{
  const f=setup(t);await f.run();
  assert.match(f.slots(3,'lunch')[0].content,/\$9.75/);
  assert.match(f.slots(3,'all-day')[0].content,/Pizza Burger.*\$10.25/);
  assert.match(f.slots(3,'all-day')[1].content,/Grilled Ham.*\$7.25/);
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  await f.run();assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.equal(f.state.aiCalls,1);
});
test('persisted failed single-day evidence can reconcile without a re-extraction; manual correction stays protected',async t=>{
  const f=setup(t);f.env.SPECIALS_IMPORT_MODE='DRY_RUN';await f.run();
  const id=f.imports()[0].id;
  f.sql("UPDATE special_imports SET processing_status='failed',validation_result='rejected',candidate_json=NULL,validation_reason=? WHERE id=?",rows[0].validation_reason,id);
  f.sql("UPDATE special_slots SET content='Staff correction',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",f.slots(3,'all-day')[0].group_id);
  const r=await reconcileToday(f.env,{sourceIds:[id],today:'2026-10-21',weekday:3});
  assert.equal(r.written,true);assert.match(f.slots(3,'all-day')[0].content,/Pizza Burger/);
  assert.equal(f.slots(3,'all-day')[1].content,'Staff correction');assert.equal(f.state.aiCalls,1);
  assert.equal(f.imports()[0].processing_status,'failed'); // original audit is not rewritten
});
test('night-first then daytime arrival merges both sources without losing prices',async t=>{
  const f=setup(t);f.state.candidate=raw(1);
  Object.assign(f.state.posts[0],{id:'night',created_time:rows[1].fb_created_time,updated_time:rows[1].fb_created_time});
  await f.run();assert.match(f.slots(3,'nightly')[0].content,/\.89/);
  f.state.candidate=raw(0);
  f.state.posts.push({...f.state.posts[0],id:'day',created_time:rows[0].fb_created_time,updated_time:rows[0].fb_created_time});
  await f.run();
  assert.match(f.slots(3,'lunch')[0].content,/\$9.75/);
  assert.match(f.slots(3,'all-day')[1].content,/Grilled Ham.*\$7.25/);
  assert.match(f.slots(3,'nightly')[0].content,/\.99/);
  assert.ok(!f.slots(3,'nightly')[0].content.includes('Add Fries'));
});
test('invalid failed evidence continues to veto publication and emits a content-free attention signal',async t=>{
  const f=setup(t);f.state.candidate.entries[1].content=f.state.candidate.entries[1].content.replace('10.25','11.25');
  f.env.SPECIALS_IMPORT_MODE='DRY_RUN';await f.run();
  f.sql("UPDATE special_imports SET processing_status='failed',validation_result='rejected',candidate_json=NULL");
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';const warn=t.mock.method(console,'warn',()=>{});
  await f.run();
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.ok(warn.mock.calls.some(c=>c.arguments[0]==='Specials import requires attention' && c.arguments[1].rejectedCount===1));
  assert.ok(!JSON.stringify(warn.mock.calls.map(c=>c.arguments)).includes('Pizza'));
});
test('concurrent staff save fences recovered single-day publication',async t=>{
  const f=setup(t),batch=f.env.DB.batch.bind(f.env.DB);let injected=false;
  f.env.DB.batch=async statements=>{
    if(!injected && statements.some(s=>s.sql.includes('UPDATE special_collections SET revision=revision+1,mutation_token'))) {
      injected=true;f.sql("UPDATE special_slots SET content='Staff correction',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",f.slots(3,'all-day')[0].group_id);
    }
    return batch(statements);
  };
  await f.run();assert.ok(injected);assert.equal(f.slots(3,'all-day')[0].content,'Staff correction');
  assert.equal(f.slots(3,'lunch')[0].content,'French Dip with Beer Fries and a Drink');
});
