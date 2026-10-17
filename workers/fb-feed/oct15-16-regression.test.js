import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeEvidenceOffer} from './evidence.js';
import {reconcilePosterEvidence} from './reconcile.js';
import {reconcileToday} from './guarded-auto.js';
import {harness} from './test-fixture.js';

const exports=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct15-16-production.json',import.meta.url),'utf8'));
const rows=exports.imports[0].results;
const candidate=i=>JSON.parse(rows[i].candidate_json);
const raw=i=>JSON.parse(rows[i].extracted_json);
const route=(p,day=5,verified=true)=>reconcilePosterEvidence(p,day,[],{
  today:`2026-10-${day===4?'15':'16'}`,verifiedSameDaySources:new Set(verified?p.map((_,i)=>i):[])});
const meals=r=>r.targets.filter(t=>t.service!=='custom');

test('stored exports retain production failures and read-only database evidence',()=>{
  for(const data of Object.values(exports)) assert.ok(data.every(e=>e.success && e.meta.rows_written===0));
  assert.ok(exports.events[0].results.some(e=>e.detail.includes('Destination capacity exceeded')));
  assert.ok(exports.events[0].results.some(e=>e.detail.includes('Meal facts differ from original evidence')));
  assert.ok(exports.misc[0].results.every(e=>e.v===(e.k==='migration15'?0:1)));
});
for(const i of [0,1]) for(const shape of ['raw','candidate']) test(`production ${i===0?'Thursday':'Friday'} ${shape}: all prices and destinations survive`,()=>{
  const p=shape==='raw'?{...raw(i),evidence_version:2}:candidate(i);
  const r=route([p],i===0?4:5);
  assert.deepEqual(r.unresolvedTargets,[]);
  assert.deepEqual(r.targets.map(t=>[t.role??t.service,t.items.map(x=>x.position)]),[['lunch',[1]],['all-day',[1,2]],['soup',[1]]]);
  assert.deepEqual(meals(r).flatMap(t=>t.items).map(x=>x.content.match(/\$\d+\.\d+/g)),[['$9.75'],['$10.25'],['$7.25']]);
  assert.match(r.targets.at(-1).items[0].content,/French Onion [Oo]r Chili/);
});
test('Thursday genuine individually corroborated times are retained; capacity conflict is not hidden',()=>{
  const p=candidate(0);p.offers.slice(0,3).forEach(o=>o.evidence+=' (11-1:30)');
  const r=route([p],4);assert.equal(meals(r).length,0);
  assert.ok(r.unresolvedTargets.some(x=>x.reason==='Destination capacity exceeded'));
});
test('Thursday distinct or conflicting service labels disable copied-time recovery',()=>{
  for(const label of ['5-10pm','All Day 11-1:30','Lunch 11-1:30']) {
    const p=candidate(0);p.offers[1].service_time=label;
    assert.ok(route([p],4).unresolvedTargets.length);
  }
});
test('a genuine time equal to the poster heading remains offer evidence',()=>{
  const p=candidate(1);p.day_of_week=5;p.day_evidence='Friday';p.poster_evidence='Friday Specials 11 AM - 1:30 PM';
  p.offers[1].evidence+=' All Day';
  p.offers[1].service_time='11 AM - 1:30 PM';
  const r=route([p]);
  assert.ok(r.unresolvedTargets.some(x=>x.reason==='Conflicting offer service evidence'));
  assert.ok(r.targets.some(t=>t.service==='lunch'));
});
test('list punctuation is presentation, bare quantities and alternatives remain exact',()=>{
  const o={content:'1 or 2 Piece Fish $12.99',evidence:'1) 1 or 2 Piece Fish $12.99',service_time:''};
  assert.equal(normalizeEvidenceOffer(o).content,o.content);
  for(const content of ['2 Piece Fish $12.99','1 and 2 Piece Fish $12.99','1 or 2 Piece Fish $13.99'])
    assert.throws(()=>normalizeEvidenceOffer({...o,content}));
  assert.throws(()=>normalizeEvidenceOffer({...o,evidence:'1 or 2 Piece Fish $12.99',content:'or 2 Piece Fish $12.99'}));
});
test('AI data cannot grant same-day trust',()=>{
  const p={...candidate(1),verifiedSameDay:true,fb_created_time:rows[1].fb_created_time};
  assert.ok(!route([p],5,false).targets.some(t=>t.service==='all-day'));
});
test('undated weekend poster cannot use the new weekday fallback',()=>{
  for(const day of [0,6]) {
    const r=reconcilePosterEvidence([candidate(1)],day,[],{today:day===6?'2026-10-17':'2026-10-18',verifiedSameDaySources:new Set([0])});
    assert.ok(!r.targets.some(t=>t.service==='all-day'));
  }
});
test('contradictory offer date blocks agreement rather than excluding the source',()=>{
  const p=candidate(1);p.offers[2].date_evidence='tomorrow';
  const r=route([candidate(1),p]);
  assert.equal(r.targets.length,0);assert.equal(r.rejectedSources.length,1);assert.equal(r.excludedSources.length,0);
});
for(const [name,mutate] of [
  ['wrong weekday',p=>{p.day_of_week=4;p.day_evidence='Thursday';}],
  ['wrong date',p=>p.poster_evidence+=' 10/15'],
  ['future date',p=>p.poster_evidence+=' Tomorrow'],
  ['weekly',p=>p.poster_evidence='Weekly Specials'],
  ['other format',p=>p.poster_evidence='Menu'],
  ['offer future date',p=>p.offers[2].date_evidence='10/17'],
  ['offer future wording',p=>p.offers[2].evidence+=' tomorrow'],
  ['future service field',p=>p.offers[2].service_time='tomorrow'],
  ['multiple unlabelled prices',p=>{p.offers[2].content+='/$8.25';p.offers[2].evidence+='/$8.25';}],
  ['missing price',p=>{p.offers[2].content=p.offers[2].content.replace('$7.25','');p.offers[2].evidence=p.offers[2].evidence.replace('$7.25','');}],
]) test(`same-day fallback rejects ${name}`,()=>{
  const p=candidate(1);mutate(p);
  assert.ok(!route([p]).targets.some(t=>t.service==='all-day'));
});
test('conflicting price or lost alternatives hold the affected meal',()=>{
  for(const mutate of [o=>o.content=o.content.replace('$10.25','$10.75'),o=>o.content=o.content.replace(' OR ',' AND ')]) {
    const p=candidate(1);mutate(p.offers[1]);const r=route([p]);
    assert.ok(r.unresolvedTargets.length);
    assert.ok(!r.targets.flatMap(t=>t.items).some(x=>x.content.includes('$10.75')));
  }
});
test('Friday evening alone stays held; two same-day posters preserve Lunch and Soup independently',()=>{
  assert.equal(route([candidate(2)]).targets.length,0);
  const r=route([candidate(1),candidate(2)]);
  assert.deepEqual(r.targets.map(t=>t.role??t.service),['lunch','soup']);
  assert.ok(r.unresolvedTargets.some(x=>x.reason==='Unresolved offer could contradict this offer'));
  assert.ok(!r.targets.some(t=>t.service==='nightly'));
});
function setup(t,i=1) {
  const day=i===0?4:5,date=i===0?'15':'16';
  const f=harness(t,{now:`2026-10-${date}T17:00:00Z`,candidate:raw(i)});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  Object.assign(f.state.posts[0],{id:rows[i].fb_post_id,created_time:rows[i].fb_created_time,updated_time:rows[i].fb_created_time});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-12',week_end_date='2026-10-18' WHERE id=9000");
  return {...f,day,today:`2026-10-${date}`};
}
for(const i of [0,1]) test(`production ${i} integrated stored/displayed prices, ownership and idempotence`,async t=>{
  const f=setup(t,i);
  for(const service of ['lunch','all-day']) f.sql("UPDATE special_slots SET content='Recurring default',origin='manual',manual_locked=0 WHERE group_id=? AND position<=?",f.slots(f.day,service)[0].group_id,service==='lunch'?1:2);
  await f.run();
  const slots=[f.slots(f.day,'lunch')[0],...f.slots(f.day,'all-day').slice(0,2)];
  for(const [j,s] of slots.entries()) {
    assert.equal(s.origin,'automation');assert.equal(s.manual_locked,0);assert.equal(s.last_auto_value,s.content);
    assert.ok([s.content,s.price].filter(Boolean).join(' ').includes(['$9.75','$10.25','$7.25'][j]));
  }
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  await f.run();assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.equal(f.state.aiCalls,1);
});
test('protected staff edit stays; unchanged prior automation can update',async t=>{
  const f=setup(t);const group=f.slots(5,'all-day')[0].group_id;
  f.sql("UPDATE special_slots SET content='Staff wins',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",group);
  f.sql("UPDATE special_slots SET content='Old automation',last_auto_value='Old automation',origin='automation',manual_locked=0 WHERE group_id=? AND position=2",group);
  await f.run();assert.equal(f.slots(5,'all-day')[0].content,'Staff wins');assert.match(f.slots(5,'all-day')[1].content,/\$7.25/);
});
test('concurrent staff edit fences the entire proposed write',async t=>{
  const f=setup(t);const batch=f.env.DB.batch.bind(f.env.DB);let injected=false;
  f.env.DB.batch=async statements=>{
    if(!injected && statements.some(s=>s.sql.includes('UPDATE special_collections SET revision=revision+1,mutation_token'))) {
      injected=true;f.sql("UPDATE special_slots SET content='Staff wins',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",f.slots(5,'all-day')[0].group_id);
    }
    return batch(statements);
  };
  await f.run();assert.ok(injected);assert.equal(f.slots(5,'all-day')[0].content,'Staff wins');assert.equal(f.slots(5,'lunch')[0].content,'');
});
test('evening arrival keeps published daytime values and records independent conflicts',async t=>{
  const f=setup(t);await f.run();
  const before=[...f.slots(5,'lunch'),...f.slots(5,'all-day')];
  f.state.now=Date.parse('2026-10-16T22:00:00Z');f.state.candidate=raw(2);
  f.state.posts.push({...f.state.posts[0],id:rows[2].fb_post_id,created_time:rows[2].fb_created_time,updated_time:rows[2].fb_created_time});
  await f.run();
  assert.deepEqual([...f.slots(5,'lunch'),...f.slots(5,'all-day')],before);
  assert.ok(f.slots(5,'nightly').every(s=>!s.content));
  assert.ok(f.sql("SELECT detail FROM special_import_events WHERE event_type='review'").some(e=>e.detail.includes('Unresolved offer could contradict')));
});
for(const time of ['invalid','2026-10-15T14:00:00Z','2026-10-16T23:00:00Z']) test(`stored timestamp ${time} cannot authorize fallback`,async t=>{
  const f=setup(t);f.env.SPECIALS_IMPORT_MODE='DRY_RUN';await f.run();
  f.sql('UPDATE special_imports SET fb_created_time=?',time);
  const r=await reconcileToday(f.env,{sourceIds:f.imports().map(i=>i.id),today:f.today,weekday:5});
  assert.equal(r.written,false);assert.equal(f.slots(5,'all-day')[0].content,'');
});
