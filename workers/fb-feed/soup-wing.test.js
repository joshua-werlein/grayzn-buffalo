import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import worker from './worker.js';
import {harness,offer,poster} from './test-fixture.js';
import {reconcilePosterEvidence} from './reconcile.js';
import {reconcileToday} from './guarded-auto.js';
import {formatWingNight,validateWingNight} from './wing-night.js';
import {standaloneSoup,soupGroupId,withSoupControls} from '../../src/lib/daily-soup.js';
import {loadTs} from '../../tests/load-ts.mjs';
import {extractionPrompt} from './extraction.js';
const store=loadTs('src/lib/specials-store.ts');
const exact=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct7-wednesday.json',import.meta.url),'utf8'));
const wing='Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each';
const pair=exact.offers.slice(1,3);
const morning=poster(3,'Wednesday Specials',[offer('Hoagie Sandwich w/ Beer Fries & a Drink - $9.75','','11 AM-1:30 PM'),...pair]);
const input={today:'2026-10-07',weekday:3};
function setup(t,candidate=exact) {
  const f=harness(t,{now:'2026-10-07T22:00:00Z',candidate:structuredClone(candidate)});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-05',week_end_date='2026-10-11' WHERE id=9000");
  Object.assign(f.state.posts[0],{created_time:'2026-10-07T21:07:14Z',updated_time:'2026-10-07T21:07:14Z'});
  f.sql("UPDATE special_slots SET content='Wing Night!\nBoneless Wings\nBone In Wings\nAdd Fries',origin='manual',manual_locked=0 WHERE group_id=? AND position=1",f.slots()[0].group_id);
  return f;
}
const soup=f=>f.sql('SELECT s.* FROM special_slots s WHERE group_id=? ORDER BY position',soupGroupId('auto-week',3));
const soupGroup=f=>f.sql('SELECT * FROM special_groups WHERE id=?',soupGroupId('auto-week',3))[0];
const revision=f=>f.sql("SELECT revision FROM special_collections WHERE id='auto-week'")[0].revision;
const audit=f=>f.sql("SELECT * FROM special_import_events WHERE event_type='review' ORDER BY id");
const reconcile=f=>reconcileToday(f.env,{...input,sourceIds:f.imports().map(s=>s.id)});
const targets=(sources,existing=[])=>reconcilePosterEvidence(sources,3,existing);

for(const existing of [[],pair]) test(`exact October 7 poster reconciles with ${existing.length ? 'established' : 'no'} All Day pair`,()=>{
  const r=targets([exact],existing);
  assert.deepEqual(r.rejectedSources,[]);
  assert.equal(r.targets.find(t=>t.service==='nightly').items[0].content,wing);
  assert.deepEqual(r.targets.find(t=>t.service==='all-day').items.map(i=>i.content),pair.map(i=>i.content));
  assert.deepEqual(r.targets.find(t=>t.role==='soup').items,[{content:'French Onion or Chili'}]);
});
for(const sources of [[morning,exact],[exact,morning]]) test(`morning/evening source order ${sources[0]===morning ? 'morning first' : 'evening first'} agrees`,()=>{
  const r=targets(sources);
  assert.equal(r.targets.length,4);
  assert.equal(r.targets.find(t=>t.service==='lunch').items[0].content,morning.offers[0].content);
  assert.equal(r.targets.find(t=>t.service==='nightly').items[0].content,wing);
});
test('Wednesday-specific mapping never applies to day-unknown or other weekday posters',()=>{
  for(const p of [{...exact,day_of_week:-1,day_evidence:''},{...exact,day_of_week:4,day_evidence:'Thursday'}])
    assert.ok(!targets([p]).targets.some(t=>t.service==='all-day'));
});
test('disagreeing Wednesday All Day source fails closed',()=>{
  const changed=structuredClone(morning);changed.offers[1].content=changed.offers[1].content.replace('10.25','11.25');
  assert.deepEqual(targets([exact,changed]).targets,[]);
});

for(const heading of ['Lunch:','Night:','Nightly:','Lunch and All Day:','5-10 PM:'])
  test(`Wednesday untimed meals cannot be assigned All Day with ${heading} evidence`,()=>{
    for(const index of [1,2]) {
      const p=structuredClone(exact);p.offers[index].evidence=`${heading} ${p.offers[index].content}`;
      assert.ok(!targets([p]).targets.some(t=>t.service==='all-day'));
    }
  });

test('Wednesday clean or corroborating All Day meal evidence keeps the bounded mapping',()=>{
  for(const heading of ['', 'All Day:']) {
    const p=structuredClone(exact);
    for(const index of [1,2])p.offers[index].evidence=`${heading} ${p.offers[index].content}`.trim();
    assert.deepEqual(targets([p]).targets.find(t=>t.service==='all-day').items.map(i=>i.content),pair.map(i=>i.content));
  }
});
for(const text of ['Sandwich w/ Soup or Coleslaw $7.25','Sandwich with Cup of Soup $7.25','Burger with soup as a side','Soup or Coleslaw','Soup:','Soup: Cup of Soup with sandwich','Soup: or','Soup: Ask today','Soup: French Onion or'])
  test(`Soup recognition excludes ${text}`,()=>assert.equal(standaloneSoup(offer(text,text)),null));
test('Soup requires matching anchored evidence and an untimed separate offer',()=>{
  assert.equal(standaloneSoup(exact.offers[3]),'French Onion or Chili');
  for(const o of [offer('Soup: French Onion',''),offer('Soup: French Onion','Soup: Chili'),offer('Soup: French Onion','Soup: French Onion','Lunch')]) assert.equal(standaloneSoup(o),null);
  assert.match(extractionPrompt(''),/standalone Soup:/);
});
test('conflicting explicit Soup sources retain rejected-source protection',()=>{
  const other=structuredClone(exact);Object.assign(other.offers[3],{content:'Soup: Tomato',evidence:'Soup: Tomato'});
  const r=targets([exact,other]);assert.deepEqual(r.targets,[]);assert.match(r.rejectedSources[0].reason,/Conflicting standalone Soup/);
});
for(const existing of [false,true]) test(`pipeline publishes exact poster, atomic Soup creation and idempotency; existing pair=${existing}`,async t=>{
  const f=setup(t);
  if(existing) pair.forEach((o,i)=>f.sql("UPDATE special_slots SET content=?,origin='automation',last_auto_value=? WHERE group_id=? AND position=?",o.content,o.content,f.slots(3,'all-day')[0].group_id,i+1));
  await f.run();assert.equal(f.slots()[0].content,wing);
  assert.deepEqual(f.slots(3,'all-day').slice(0,2).map(s=>s.content),pair.map(o=>o.content));
  assert.equal(soup(f)[0].content,'French Onion or Chili');assert.equal(soup(f).length,4);
  assert.ok(soup(f).slice(1).every(s=>s.content===''));assert.equal(soup(f)[0].origin,'automation');
  assert.equal(soupGroup(f).service,'custom');assert.equal(soupGroup(f).label,'Soup');
  assert.deepEqual(JSON.parse(f.imports()[0].candidate_json),exact);
  const before=[revision(f),audit(f),f.state.aiCalls];await f.run();assert.deepEqual([revision(f),audit(f),f.state.aiCalls],before);
});
test('later omission never clears Soup; an edited source can update unchanged automation',async t=>{
  const f=setup(t);await f.run();f.state.candidate.offers.pop();f.state.posts[0].updated_time='2026-10-07T21:10:00Z';await f.run();
  assert.equal(soup(f)[0].content,'French Onion or Chili');
  f.state.candidate=structuredClone(exact);Object.assign(f.state.candidate.offers[3],{content:'Soup: Tomato',evidence:'Soup: Tomato'});
  f.state.posts[0].updated_time='2026-10-07T21:12:00Z';await f.run();assert.equal(soup(f)[0].content,'Tomato');
});
test('unrelated custom group named Soup is never the automation destination',async t=>{
  const f=setup(t);f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label) VALUES('unrelated','auto-week',3,'custom','Soup')");
  f.sql("INSERT INTO special_slots(group_id,position,content) VALUES('unrelated',1,'Staff custom')");
  await f.run();assert.equal(soup(f)[0].content,'French Onion or Chili');assert.equal(f.sql("SELECT content FROM special_slots WHERE group_id='unrelated'")[0].content,'Staff custom');
});
for(const action of ['manual','hide','clear']) test(`staff ${action} protects Soup on later scans`,async t=>{
  const f=setup(t);await f.run();const week=await store.readWeek(f.env,9000);const g=week.collection.groups.find(g=>g.id===soupGroupId('auto-week',3));
  if(action==='manual')g.slots[0].content='Tomato';else if(action==='hide')g.enabled=0;else g.slots[0].content='';
  await store.saveCollection(f.env,week.collection,{start:week.week_start_date,end:week.week_end_date});await reconcile(f);
  assert.equal(soup(f)[0].content,action==='manual'?'Tomato':action==='clear'?'':'French Onion or Chili');
  if(action==='manual')assert.equal(soup(f)[0].manual_locked,1);else assert.equal(soupGroup(f).enabled,0);
});
test('manual Wednesday Nightly remains protected while Soup and sandwiches publish',async t=>{
  const f=setup(t);f.sql("UPDATE special_slots SET content='Staff Wing special',manual_locked=1 WHERE group_id=? AND position=1",f.slots()[0].group_id);
  await f.run();assert.equal(f.slots()[0].content,'Staff Wing special');assert.equal(soup(f)[0].content,'French Onion or Chili');assert.match(audit(f).at(-1).detail,/Protected/);
});
for(const race of ['revision','slot','group','source','pending','failure'])test(`Soup creation is atomic under ${race} race/failure`,async t=>{
  const f=setup(t);await f.run();f.sql('DELETE FROM special_groups WHERE id=?',soupGroupId('auto-week',3));
  const rev=revision(f),events=audit(f),batch=f.env.DB.batch;
  f.env.DB.batch=statements=>{
    if(statements[0].sql.startsWith('UPDATE special_collections')) {
      if(race==='revision')f.sql("UPDATE special_collections SET revision=revision+1 WHERE id='auto-week'");
      if(race==='slot')f.sql("UPDATE special_slots SET content='Racing staff' WHERE group_id=? AND position=1",f.slots()[0].group_id);
      if(race==='group')f.sql("UPDATE special_groups SET label='Racing label' WHERE id=?",f.slots()[0].group_id);
      if(race==='source')f.sql("UPDATE special_imports SET review_status='dismissed'");
      if(race==='pending')f.sql("UPDATE special_imports SET processing_status='pending'");
      if(race==='failure')return batch([...statements,{sql:'INSERT INTO missing_table VALUES(1)',args:[]}]);
    }
    return batch(statements);
  };
  if(race==='failure')await assert.rejects(()=>reconcile(f));else assert.equal((await reconcile(f)).written,false);
  assert.equal(soupGroup(f),undefined);assert.deepEqual(soup(f),[]);assert.deepEqual(audit(f),events);assert.equal(revision(f),rev+(race==='revision'?1:0));
});
test('conflicting Soup writes audit only, never publishes',async t=>{
  const f=setup(t);await f.run();const source=f.imports()[0];const other=structuredClone(exact);Object.assign(other.offers[3],{content:'Soup: Tomato',evidence:'Soup: Tomato'});
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,parser_version,candidate_json,validation_result,processing_status,image_r2_key)
    VALUES('conflict','other',?,?,?,?,?,?)`,source.fb_created_time,source.parser_version,JSON.stringify(other),'ok','staged','proof');
  const before=soup(f);const r=await reconcile(f);assert.equal(r.written,false);assert.deepEqual(soup(f),before);assert.match(audit(f).at(-1).detail,/Conflicting standalone Soup/);
});
for(const token of ['$.89','$ .89','$0.89'])test(`Wing prices preserve monetary associations for ${token}`,()=>{
  const result=formatWingNight(`Wing Night Boneless $.99 each / Bone In ${token} each`);
  assert.equal(result,`Wing Night!\nBone-In Wings ${token.replace(/\s/g,'')} each\nBoneless Wings $.99 each`);
});
test('Wing prices may precede labels, change, and retain source-only fries',()=>{
  assert.equal(formatWingNight('Wing Night $.99 Boneless Wings each / $.89 Bone In Wings each'),wing);
  assert.equal(formatWingNight('Wing Night $.99 Boneless Wings / $.89 Bone In Wings'),wing.replaceAll(' each',''));
  assert.equal(formatWingNight('Wing Night Bone-In $1.25 each / Boneless $1.50 each'),wing.replace('$.89','$1.25').replace('$.99','$1.50'));
  assert.equal(formatWingNight('Wing Night Bone-In $.89 each / Boneless $.99 each Add Fries'),wing+'\nAdd Fries');
  assert.equal(formatWingNight('Wing Night Bone-In $.89 each / Boneless $.99 each Add Fries $2'),wing+'\nAdd Fries $2');
  assert.equal(validateWingNight('Wing Night Bone-In $.89 each / Boneless $.99 each Add Fries','Wing Night'),null);
});

for(const evidence of ['WING NIGHT','','Wing Night Bone-In / Boneless','Wing Night $.89 $.99','Wing Night Bone-In $.89 each / Boneless'])
  test(`automated Wing publication requires complete labelled price evidence: ${JSON.stringify(evidence)}`,async t=>{
    const p=structuredClone(exact);p.offers[0].evidence=evidence;
    assert.equal(validateWingNight(p.offers[0].content,evidence),null);
    // A valid second source must not make insufficient evidence disappear.
    for(const sources of [[p],[exact,p],[p,exact]])assert.ok(!targets(sources).targets.some(t=>t.service==='nightly'));
    const f=setup(t,p),before=f.slots()[0];await f.run();
    assert.deepEqual(f.slots()[0],before);
    assert.equal(soup(f)[0].content,'French Onion or Chili');
    assert.match(audit(f).at(-1).detail,/ambiguous Wing Night prices/);
  });

test('complete Wing evidence validates reversed labels and equivalent monetary notation',()=>{
  assert.equal(validateWingNight(exact.offers[0].content,'Wing Night Boneless $0.99 each / Bone In $0.89 each'),wing);
});

for(const evidence of [
  'Wing Night Add Fries',
  'Wing Night Bone-In $.89 each / Boneless $.99 each Add Fries',
  'Wing Night Bone-In $.89 each / Boneless $.99 each',
  'Wing Night Bone-In $.89 each / Boneless $.99 each Add Fries $3',
])test(`priced Add Fries publication requires matching add-on evidence: ${evidence}`,()=>{
  const p=structuredClone(exact);p.offers[0].content+=' Add Fries $2';p.offers[0].evidence=evidence;
  assert.equal(validateWingNight(p.offers[0].content,evidence),null);
  assert.ok(!targets([p]).targets.some(t=>t.service==='nightly'));
});

test('priced Add Fries is accepted only with matching evidence and remains idempotent',()=>{
  const p=structuredClone(exact);p.offers[0].content+=' Add Fries $2';p.offers[0].evidence+=' Add Fries $2.00';
  const validated=validateWingNight(p.offers[0].content,p.offers[0].evidence);
  assert.equal(validated,wing+'\nAdd Fries $2');
  assert.equal(formatWingNight(validated),validated);
  assert.equal(targets([p]).targets.find(t=>t.service==='nightly').items[0].content,validated);
});

test('unpriced Add Fries also requires explicit evidence',()=>{
  const content=exact.offers[0].content+' Add Fries';
  assert.equal(validateWingNight(content,exact.offers[0].evidence),null);
  assert.equal(validateWingNight(content,exact.offers[0].evidence+' Add Fries'),wing+'\nAdd Fries');
});

for(const fries of ['', ' Add Fries $2'])test(`equivalent Wing item order agrees across sources${fries}`,()=>{
  const first=structuredClone(exact);first.offers[0].content+=fries;first.offers[0].evidence+=fries;
  const second=structuredClone(first);
  second.offers[0].content=`Wing Night Boneless $0.99 each / Bone In $0.89 each${fries.replace('$2','$2.00')}`;
  second.offers[0].evidence=second.offers[0].content;
  for(const sources of [[first,second],[second,first]]) {
    const r=targets(sources),night=r.targets.find(t=>t.service==='nightly');
    assert.ok(night);assert.deepEqual(r.unresolvedTargets,[]);
    assert.equal(formatWingNight(night.items[0].content),night.items[0].content);
    assert.deepEqual(r.targets.find(t=>t.service==='all-day').items.map(i=>i.content),pair.map(i=>i.content));
  }
  // Numeric changes still conflict even after item order is normalized.
  second.offers[0].content=second.offers[0].content.replace('$0.99','$1.09');second.offers[0].evidence=second.offers[0].content;
  for(const sources of [[first,second],[second,first]])assert.ok(!targets(sources).targets.some(t=>t.service==='nightly'));
});

test('insufficient Add Fries evidence preserves the existing Nightly destination',async t=>{
  const p=structuredClone(exact);p.offers[0].content+=' Add Fries $7';p.offers[0].evidence+=' Add Fries';
  const f=setup(t,p),before=f.slots()[0];await f.run();assert.deepEqual(f.slots()[0],before);
  assert.equal(soup(f)[0].content,'French Onion or Chili');
});
for(const text of ['Wing Night','Wing Night Bone-In $.89 / Boneless','Wing Night $.89 $.99','Wing Night Bone-In $.890 / Boneless $.99','Wing Night Bone-In -$.89 / Boneless $.99','Wing Night Bone-In $.89-.99 / Boneless $.99','Wing Night Bone-In $.89 / Bone-In $.99'])test(`Wing fails closed for ${text}`,()=>assert.equal(formatWingNight(text),null));
test('conflicting printed Wing evidence or sources cannot manufacture agreement',()=>{
  assert.equal(validateWingNight(exact.offers[0].content,'Wing Night Bone-In $.99 each / Boneless $.89 each'),null);
  const p=structuredClone(exact);p.offers[0].content='Wing Night Bone-In $.99 / Boneless $.89';p.offers[0].evidence=p.offers[0].content;
  assert.ok(!targets([exact,p]).targets.some(t=>t.service==='nightly'));
});
test('malformed Wing retains destination but valid Soup and All Day publish with audit',async t=>{
  const f=setup(t);f.state.candidate.offers[0].content='Wing Night Bone-In $.89 / Boneless';
  const old=f.slots()[0].content;await f.run();assert.equal(f.slots()[0].content,old);assert.equal(soup(f)[0].content,'French Onion or Chili');assert.match(audit(f).at(-1).detail,/ambiguous Wing Night prices/);
});
test('old weeks read without writes and new weeks never copy Soup content',async t=>{
  const f=setup(t);const rev=revision(f);const old=await store.readWeek(f.env,9000);assert.equal(old.collection.groups.length,21);assert.equal(revision(f),rev);
  assert.equal(withSoupControls(old.collection).groups.length,28);assert.equal(revision(f),rev);
  await f.run();const next=store.newWeekFromDefaults(await store.readCollection(f.env,'defaults'));
  assert.ok(!next.groups.some(g=>g.id.startsWith('soup:')));
  const saved=await store.saveCollection(f.env,next,{start:'2026-10-12',end:'2026-10-18'});
  assert.ok(withSoupControls((await store.readWeek(f.env,saved.id)).collection).groups.filter(g=>g.id.startsWith('soup:')).every(g=>g.slots.every(s=>s.content==='')));
});
test('automatic next-week provisioning leaves Soup structurally absent, never carrying this week',async t=>{
  const f=setup(t);await f.run();f.state.now=Date.parse('2026-10-14T22:00:00Z');await f.run();
  const next=f.sql("SELECT c.id FROM special_collections c JOIN weekly_specials w ON w.id=c.weekly_special_id WHERE w.week_start_date='2026-10-12'")[0];
  assert.ok(next);assert.ok(!f.sql('SELECT * FROM special_groups WHERE collection_id=?',next.id).some(g=>g.id.startsWith('soup:')));
  assert.equal(soup(f)[0].content,'French Onion or Chili');
});
test('real local D1: Soup creation and audit roll back together, then retry is idempotent',async t=>{
  const f=setup(t);await f.run();f.sql('DELETE FROM special_groups WHERE id=?',soupGroupId('auto-week',3));
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  for(const table of ['weekly_specials','special_collections','special_groups','special_slots','special_migration_checks','special_imports','special_import_events']){
    await DB.prepare(f.sql('SELECT sql FROM sqlite_master WHERE name=?',table)[0].sql).run();
    for(const row of f.sql(`SELECT * FROM ${table}`))await DB.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row)).run();
  }
  const args={...input,sourceIds:f.imports().map(s=>s.id)};
  const before=await DB.prepare("SELECT revision FROM special_collections WHERE id='auto-week'").first();
  const events=await DB.prepare('SELECT * FROM special_import_events ORDER BY id').all();
  const failing={DB:{prepare:DB.prepare.bind(DB),batch:stmts=>DB.batch([...stmts,DB.prepare('INSERT INTO missing_table VALUES(1)')])}};
  await assert.rejects(()=>reconcileToday(failing,args));
  assert.equal(await DB.prepare('SELECT id FROM special_groups WHERE id=?').bind(soupGroupId('auto-week',3)).first(),null);
  assert.deepEqual(await DB.prepare("SELECT revision FROM special_collections WHERE id='auto-week'").first(),before);
  assert.deepEqual((await DB.prepare('SELECT * FROM special_import_events ORDER BY id').all()).results,events.results);
  assert.equal((await reconcileToday({DB},args)).written,true);
  assert.equal((await DB.prepare('SELECT content FROM special_slots WHERE group_id=? AND position=1').bind(soupGroupId('auto-week',3)).first()).content,'French Onion or Chili');
  assert.equal((await reconcileToday({DB},args)).written,false);
});
test('unchanged cron and queue handlers reconcile exact fixture equivalently',async t=>{
  const f=setup(t);f.env.FB_KV={get:async()=>null,put:async()=>{}};
  const tasks=[];await worker.scheduled({},f.env,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);
  const snapshot=[f.slots(),f.slots(3,'all-day'),soup(f),revision(f),audit(f)];
  await worker.queue({messages:[{id:'one',body:{type:'facebook-feed-change'}}]},f.env);
  assert.deepEqual([f.slots(),f.slots(3,'all-day'),soup(f),revision(f),audit(f)],snapshot);assert.equal(f.state.aiCalls,1);
  // Re-run from blank eligible rows so the queue path independently publishes.
  f.sql("UPDATE special_slots SET content='',origin='legacy',manual_locked=0,last_auto_value=NULL WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id='auto-week')");
  await worker.queue({messages:[{id:'two',body:{type:'facebook-feed-change'}}]},f.env);
  assert.equal(f.slots()[0].content,wing);assert.equal(soup(f)[0].content,'French Onion or Chili');
});
