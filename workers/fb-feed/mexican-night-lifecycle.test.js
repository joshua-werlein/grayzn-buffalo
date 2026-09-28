import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from '../../tests/specials-fixture.mjs';
import {loadTs} from '../../tests/load-ts.mjs';
import {ensureAutomaticWeek} from './auto-week.js';
import {harness} from './test-fixture.js';
import {reconcileMexicanNight} from './guarded-auto.js';
import {mexicanNightDetailVisible} from '../../src/lib/mexican-night-visibility.js';
const store=loadTs('src/lib/specials-store.ts');
const sunday={today:'2030-01-13',weekday:0,hour:19};
const sundayNow='2030-01-14T01:00:00Z';
const following={today:'2030-01-20',weekday:0,hour:19};
const migration=readFileSync('migrations/0019_mexican_night_recurring.sql','utf8');
const collection=f=>f.sql("SELECT * FROM special_collections WHERE id='mexican-night'")[0];
const slots=(f,id='mexican-night')=>f.sql('SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id=? ORDER BY g.sort,s.position',id);
const snapshot=f=>JSON.stringify({collection:collection(f),groups:f.sql("SELECT * FROM special_groups WHERE collection_id='mexican-night' ORDER BY id"),slots:slots(f)});
function legacyMenu(f) {
  f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort) VALUES('original-menu','mexican-night',-1,'custom','Stored owner defaults','5–10 PM',0)");
  for(let position=1;position<=4;position++) f.sql("INSERT INTO special_slots(group_id,position,content,price,origin,manual_locked) VALUES('original-menu',?,?,?,'manual',1)",position,position===1?'Stored burrito\nExisting description':position===2?'Existing add-on':'',position===1?'$9.25':'');
}
function applyMigration(f) {
  return f.execute({statements:migration.split(/;\s*\n/).map(sql=>sql.trim()).filter(Boolean).map(sql=>({sql,args:[]}))});
}
function seededFixture(t) {
  const f=fixture(t,{beforeMexicanMigration:true});
  legacyMenu(f);applyMigration(f);f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  t.mock.method(Date,'now',()=>Date.parse(sundayNow));
  return f;
}
function installHarnessTemplate(f) {
  legacyMenu(f);
  f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled) SELECT 'mn-default:'||id,'mexican-night-defaults',day_of_week,service,label,service_time,sort,enabled FROM special_groups WHERE id='original-menu'");
  f.sql("INSERT INTO special_slots(group_id,position,content,price,origin,manual_locked) SELECT 'mn-default:'||group_id,position,content,price,origin,manual_locked FROM special_slots WHERE group_id='original-menu'");
}
function facebookHarness(t) {
  const f=harness(t,{now:sundayNow,week:false,caption:'Mexican Night',candidate:{type:'mexican-night',poster_evidence:'Mexican Night',schedule:'Tuesday 5–10 PM',groups:[{label:'Poster menu',items:[{title:'Facebook burrito $11',description:'Fresh poster description'}]}]}});
  installHarnessTemplate(f);
  return f;
}
function setMondayPoster(f,id='mexican-poster') {
  f.state.now=Date.parse('2030-01-14T15:00:00Z');
  f.state.posts=[{...f.state.posts[0],id,message:'Mexican Night',created_time:'2030-01-14T14:00:00Z',updated_time:'2030-01-14T14:00:00Z',full_picture:'https://cdn.example/menu.jpg'}];
}

test('migration copies existing unpublished defaults without changing live values or locks',t=>{
  const f=fixture(t,{beforeMexicanMigration:true});legacyMenu(f);const before=slots(f);applyMigration(f);
  assert.deepEqual(slots(f),before);
  assert.deepEqual(slots(f,'mexican-night-defaults').map(({group_id,...s})=>s),before.map(({group_id,...s})=>s));
  assert.equal(collection(f).updated_at,null);
  assert.equal(collection(f).section_source,'recurring');
});
for(const published of [true,false]) test(`migration never adopts ${published?'published':'automated'} content as defaults`,t=>{
  const f=fixture(t,{beforeMexicanMigration:true});legacyMenu(f);
  if(published) f.sql("UPDATE special_collections SET updated_at='2030-01-08T12:00:00Z' WHERE id='mexican-night'");
  else f.sql("UPDATE special_slots SET origin='automation' WHERE group_id='original-menu'");
  applyMigration(f);assert.equal(f.sql("SELECT * FROM special_collections WHERE id='mexican-night-defaults'").length,0);
});

test('Sunday week creation publishes exact detailed defaults, Tuesday metadata, and separate weekly summary',async t=>{
  const f=seededFixture(t);await ensureAutomaticWeek(f.env,sunday);
  const c=collection(f);assert.equal(c.section_week_start,'2030-01-14');assert.equal(c.section_service_date,'2030-01-15');
  assert.equal(c.updated_at,new Date(sundayNow).toISOString());assert.equal(c.section_source,'recurring');assert.equal(c.revision,1);
  const defaults=slots(f,'mexican-night-defaults');const live=slots(f);
  assert.equal(live.length,defaults.length);
  live.forEach((s,i)=>{for(const key of ['content','price','position','section_link']) assert.equal(s[key],defaults[i][key]);assert.equal(s.manual_locked,0);assert.equal(s.origin,'manual');assert.equal(s.last_auto_value,null);});
  const summary=f.sql("SELECT s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id JOIN special_collections c ON c.id=g.collection_id JOIN weekly_specials w ON w.id=c.weekly_special_id WHERE w.week_start_date='2030-01-14' AND g.day_of_week=2 AND g.service='nightly'");
  assert.ok(summary.some(s=>/Mexican Night!\s+Ask to see our Menu!/.test(s.content)));
});
for(const [label,now,visible] of [
  ['Sunday night',sundayNow,true],['Monday','2030-01-14T18:00:00Z',true],
  ['Tuesday','2030-01-16T01:00:00Z',true],['Wednesday 1:59','2030-01-16T07:59:00Z',true],
  ['Wednesday 2:00','2030-01-16T08:00:00Z',false],
]) test(`seeded details visibility: ${label}`,async t=>{
  const f=seededFixture(t);await ensureAutomaticWeek(f.env,sunday);const before=snapshot(f);
  assert.equal(mexicanNightDetailVisible(collection(f).updated_at,new Date(now)),visible);
  assert.equal(snapshot(f),before,'hiding is display-only');
});
test('repeated and concurrent Sunday execution is idempotent',async t=>{
  const f=seededFixture(t);await ensureAutomaticWeek(f.env,sunday);const before=snapshot(f);
  await Promise.all(Array.from({length:3},()=>ensureAutomaticWeek(f.env,sunday)));
  assert.equal(snapshot(f),before);assert.equal(f.sql("SELECT * FROM weekly_specials WHERE week_start_date='2030-01-14'").length,1);
});
test('following Sunday publishes a new Tuesday from the current stored template',async t=>{
  const f=seededFixture(t);await ensureAutomaticWeek(f.env,sunday);
  f.sql("UPDATE special_slots SET content='Updated recurring recipe' WHERE group_id='mn-default:original-menu' AND position=1");
  t.mock.method(Date,'now',()=>Date.parse('2030-01-21T01:00:00Z'));
  await ensureAutomaticWeek(f.env,following);
  assert.equal(collection(f).section_week_start,'2030-01-21');assert.equal(collection(f).section_service_date,'2030-01-22');
  assert.equal(collection(f).updated_at,'2030-01-21T01:00:00.000Z');assert.equal(slots(f)[0].content,'Updated recurring recipe');
  assert.equal(slots(f).length,4);
});
test('valid Facebook menu replaces unlocked defaults; repeats preserve Facebook content and timestamp',async t=>{
  const f=facebookHarness(t);await ensureAutomaticWeek(f.env,sunday);const template=slots(f,'mexican-night-defaults');
  setMondayPoster(f);await f.run();
  assert.equal(collection(f).section_source,'facebook');assert.equal(collection(f).section_week_start,'2030-01-14');
  assert.equal(collection(f).section_service_date,'2030-01-15');assert.equal(slots(f)[0].origin,'automation');
  assert.equal(slots(f)[0].content,slots(f)[0].last_auto_value);assert.match(slots(f)[0].content,/Facebook burrito/);
  const before=snapshot(f);await ensureAutomaticWeek(f.env,sunday);assert.equal(snapshot(f),before);
  assert.deepEqual(slots(f,'mexican-night-defaults'),template);
  f.state.now=Date.parse('2030-01-21T01:00:00Z');await ensureAutomaticWeek(f.env,following);
  assert.equal(collection(f).section_source,'recurring');assert.equal(slots(f)[0].content,template[0].content);
});
test('real staff save protects menu against a new Facebook poster and later Sunday defaults',async t=>{
  const f=facebookHarness(t);await ensureAutomaticWeek(f.env,sunday);
  const edit=await store.readCollection(f.env,'mexican-night');edit.groups[0].slots[0].content='Staff corrected recipe';
  await store.saveCollection(f.env,edit);
  assert.equal(slots(f)[0].manual_locked,1);assert.equal(collection(f).section_source,'manual');
  const before=snapshot(f);setMondayPoster(f);await f.run();assert.equal(snapshot(f),before);
  f.state.now=Date.parse('2030-01-21T01:00:00Z');await ensureAutomaticWeek(f.env,following);assert.equal(snapshot(f),before);
});
for(const alteration of ["manual_locked=1","content='Untracked manual edit',origin='automation',last_auto_value='Old automation'"])
test(`Facebook and next-week seeding fail closed for ${alteration}`,async t=>{
  const f=facebookHarness(t);await ensureAutomaticWeek(f.env,sunday);
  f.sql(`UPDATE special_slots SET ${alteration} WHERE group_id=? AND position=1`,slots(f)[0].group_id);
  const before=snapshot(f);setMondayPoster(f);await f.run();assert.equal(snapshot(f),before);
  f.state.now=Date.parse('2030-01-21T01:00:00Z');await ensureAutomaticWeek(f.env,following);assert.equal(snapshot(f),before);
});
test('staff edit between migration and first seed protects the unpublished original menu',async t=>{
  const f=seededFixture(t);const edit=await store.readCollection(f.env,'mexican-night');edit.groups[0].slots[0].content='Staff before first publication';
  await store.saveCollection(f.env,edit);const before=snapshot(f);await ensureAutomaticWeek(f.env,sunday);assert.equal(snapshot(f),before);
});
test('old staged Mexican Night evidence cannot backfill a later day',async t=>{
  const f=facebookHarness(t);await ensureAutomaticWeek(f.env,sunday);setMondayPoster(f);
  f.env.SPECIALS_IMPORT_MODE='DRY_RUN';await f.run();const before=snapshot(f);
  f.state.now=Date.parse('2030-01-15T15:00:00Z');f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  const result=await reconcileMexicanNight(f.env);assert.equal(result.written,false);assert.equal(snapshot(f),before);
});
test('whole transaction rolls back weekly and detailed publication together',async t=>{
  const f=seededFixture(t);const before=snapshot(f);const weeks=f.sql('SELECT * FROM weekly_specials');const batch=f.env.DB.batch;
  f.env.DB.batch=statements=>batch([...statements,{sql:'INSERT INTO missing_table VALUES(1)',args:[]}]);
  await assert.rejects(()=>ensureAutomaticWeek(f.env,sunday));assert.equal(snapshot(f),before);assert.deepEqual(f.sql('SELECT * FROM weekly_specials'),weeks);
});
test('missing or empty template never fabricates a menu or publication',async t=>{
  const f=fixture(t);f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';const before=snapshot(f);
  await ensureAutomaticWeek(f.env,sunday);assert.equal(snapshot(f),before);
  f.sql("DELETE FROM special_collections WHERE id='mexican-night-defaults'");
  await ensureAutomaticWeek(f.env,sunday);assert.equal(snapshot(f),before);
});

test('Sunday before the 7 PM rollover cannot republish the previous Tuesday',async t=>{
  const f=seededFixture(t);const before=snapshot(f);
  await ensureAutomaticWeek(f.env,{...sunday,hour:18});assert.equal(snapshot(f),before);
  await ensureAutomaticWeek(f.env,sunday);assert.equal(collection(f).section_service_date,'2030-01-15');
});
test('existing exact week can receive missing details without changing its weekly slots',async t=>{
  const f=seededFixture(t);
  f.sql("UPDATE special_groups SET enabled=0 WHERE collection_id='mexican-night-defaults'");
  await ensureAutomaticWeek(f.env,sunday);
  const before=f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id JOIN special_collections c ON c.id=g.collection_id WHERE c.kind='week' ORDER BY s.group_id,s.position");
  f.sql("UPDATE special_groups SET enabled=1 WHERE collection_id='mexican-night-defaults'");
  await ensureAutomaticWeek(f.env,sunday);assert.equal(collection(f).section_source,'recurring');assert.equal(collection(f).section_week_start,'2030-01-14');
  assert.deepEqual(f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id JOIN special_collections c ON c.id=g.collection_id WHERE c.kind='week' ORDER BY s.group_id,s.position"),before);
});
test('lock set after Facebook snapshot but before transaction prevents every menu mutation',async t=>{
  const f=facebookHarness(t);await ensureAutomaticWeek(f.env,sunday);setMondayPoster(f);
  const batch=f.env.DB.batch;let protectedSnapshot;
  f.env.DB.batch=statements=>{
    if(statements.some(s=>s.sql.includes("section_source='facebook'"))) {
      f.sql('UPDATE special_slots SET manual_locked=1 WHERE group_id=? AND position=1',slots(f)[0].group_id);
      protectedSnapshot=snapshot(f);
    }
    return batch(statements);
  };
  await f.run();assert.ok(protectedSnapshot);assert.equal(snapshot(f),protectedSnapshot);
});

test('real D1 publishes weekly and Mexican defaults atomically and retries without duplicates',async t=>{
  const {Miniflare}=await import('miniflare');
  const f=seededFixture(t);
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  for(const table of ['weekly_specials','special_collections','special_groups','special_slots','special_migration_checks']) {
    await DB.prepare(f.sql('SELECT sql FROM sqlite_master WHERE name=?',table)[0].sql).run();
    const rows=f.sql(`SELECT * FROM ${table}`);
    for(const row of rows) await DB.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row)).run();
  }
  const env={DB,SPECIALS_IMPORT_MODE:'GUARDED_AUTO'};
  const failing={...env,DB:{prepare:DB.prepare.bind(DB),batch:statements=>DB.batch([...statements,DB.prepare('INSERT INTO missing_table VALUES(1)')])}};
  await assert.rejects(()=>ensureAutomaticWeek(failing,sunday));
  assert.equal((await DB.prepare("SELECT section_week_start FROM special_collections WHERE id='mexican-night'").first()).section_week_start,null);
  assert.equal((await DB.prepare("SELECT count(*) n FROM weekly_specials WHERE week_start_date='2030-01-14'").first()).n,0);
  await ensureAutomaticWeek(env,sunday);
  const before=await DB.prepare("SELECT * FROM special_collections WHERE id='mexican-night'").first();
  assert.equal(before.section_service_date,'2030-01-15');assert.equal(before.section_source,'recurring');
  await ensureAutomaticWeek(env,sunday);
  assert.deepEqual(await DB.prepare("SELECT * FROM special_collections WHERE id='mexican-night'").first(),before);
  const live=(await DB.prepare("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='mexican-night'").all()).results;
  assert.equal(live.length,4);assert.ok(live.every(s=>s.manual_locked===0));
});
