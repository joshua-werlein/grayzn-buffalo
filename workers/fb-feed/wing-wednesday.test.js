import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,offer,poster} from './test-fixture.js';
import {ensureAutomaticWeek} from './auto-week.js';
import {reconcileWingWednesday,recordWingScan} from './wing-wednesday.js';
import {loadTs} from '../../tests/load-ts.mjs';
import {fixture} from '../../tests/specials-fixture.mjs';
import {wingWednesdayVisible,parseWingSauces} from '../../src/lib/wing-wednesday.js';
const store=loadTs('src/lib/specials-store.ts');

const SAUCES=['Sweet Chili','BBQ','Honey BBQ','Jack BBQ','Sweet & Sour','Honey Garlic','Ranch','Chipotle Ranch','Mango Habanero','Boom Boom','Sriracha Ranch','Buffalo','Teriyaki','Honey Mustard','Garlic Parmesan','Signature'];
const OPTIONS='ww-live:ww-default:wings', LIVE_SAUCES='ww-live:ww-default:sauces';
const wingText='Wing Night — Bone-In $.89 each / Boneless $.99 each';
const collection=f=>f.sql("SELECT * FROM special_collections WHERE id='wing-wednesday'")[0];
const options=f=>f.sql('SELECT content FROM special_slots WHERE group_id=? ORDER BY position',OPTIONS).map(s=>s.content);
const sauces=f=>f.sql('SELECT content FROM special_slots WHERE group_id=? AND position=1',LIVE_SAUCES)[0].content;
const decisions=f=>f.sql('SELECT * FROM wing_wednesday_decisions ORDER BY rowid');
const scan=async f=>({today:'2030-01-09',sourceIds:f.imports().map(source=>source.id),scanToken:await recordWingScan(f.env,Date.now())});
const wingPoster=(text=wingText,evidence=text)=>poster(3,'Wing Night',[offer(text,evidence,'5-10 PM')]);
const addWeek=(f,id,start,end)=>{
  f.sql('INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(?,?,?)',id,start,end);
  f.sql("INSERT INTO special_collections(id,kind,weekly_special_id) VALUES(?,'week',?)",`w${id}`,id);
};
// Times use CST (UTC-6): January 2030. Wed Jan 9 is the service date of the harness week.
test('visibility: lead-in through Wednesday night, hidden at 2:00 AM Thursday Chicago',()=>{
  const date='2030-01-09';
  for(const [at,expected,label] of [
    ['2030-01-06T05:59:00Z',false,'Saturday 11:59 PM'],
    ['2030-01-06T06:00:00Z',false,'Sunday 12:00 AM'],
    ['2030-01-07T00:59:59Z',false,'Sunday 6:59:59 PM'],
    ['2030-01-07T01:00:00Z',true,'Sunday 7:00 PM'],
    ['2030-01-07T18:00:00Z',true,'Monday noon'],
    ['2030-01-10T02:00:00Z',true,'Wednesday 8 PM'],
    ['2030-01-10T07:59:59Z',true,'Thursday 1:59:59 AM'],
    ['2030-01-10T08:00:00Z',false,'Thursday 2:00 AM'],
    ['2030-01-11T18:00:00Z',false,'Friday noon'],
    ['2030-01-14T18:00:00Z',false,'the following Monday'],
  ]) assert.equal(wingWednesdayVisible(date,new Date(at)),expected,label);
  assert.equal(wingWednesdayVisible(null,new Date('2030-01-09T18:00:00Z')),false);
  assert.equal(wingWednesdayVisible('not-a-date',new Date('2030-01-09T18:00:00Z')),false);
});
test('visibility cutoff follows Chicago time across daylight saving',()=>{
  assert.equal(wingWednesdayVisible('2030-07-10',new Date('2030-07-11T06:59:59Z')),true);
  assert.equal(wingWednesdayVisible('2030-07-10',new Date('2030-07-11T07:00:00Z')),false);
  assert.equal(wingWednesdayVisible('2030-07-10',new Date('2030-07-07T23:59:59Z')),false,'CDT Sunday 6:59:59 PM');
  assert.equal(wingWednesdayVisible('2030-07-10',new Date('2030-07-08T00:00:00Z')),true,'CDT Sunday 7:00 PM');
  // Clocks fall back on Sunday Nov 3, 2030, so that week's rules run in CST.
  assert.equal(wingWednesdayVisible('2030-11-06',new Date('2030-11-07T07:59:59Z')),true);
  assert.equal(wingWednesdayVisible('2030-11-06',new Date('2030-11-07T08:00:00Z')),false);
  assert.equal(wingWednesdayVisible('2030-11-06',new Date('2030-11-04T00:59:59Z')),false,'CST Sunday 6:59:59 PM on change day');
  assert.equal(wingWednesdayVisible('2030-11-06',new Date('2030-11-04T01:00:00Z')),true,'CST Sunday 7:00 PM on change day');
});

test('migration: every bartender-verified sauce is stored once; no price is stored',t=>{
  const f=fixture(t);
  for(const id of ['ww-default:sauces',LIVE_SAUCES]) assert.deepEqual(parseWingSauces(f.sql('SELECT content FROM special_slots WHERE group_id=? AND position=1',id)[0].content),SAUCES);
  const all=f.sql("SELECT s.content,s.price FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id LIKE 'wing-wednesday%'");
  assert.equal(all.length,16);
  assert.ok(all.every(s=>s.price==='' && !/\$|\d/.test(s.content)));
  assert.equal(collection(f).section_service_date,null,'hidden until a week is associated');
});

function rolloverFixture(t) {
  const f=fixture(t);f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  t.mock.method(Date,'now',()=>Date.parse('2030-01-14T01:00:00Z'));
  return f;
}
test('weekly rollover: Sunday 7 PM prepares next Wednesday from defaults, in one transaction',async t=>{
  const f=rolloverFixture(t);
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  const c=collection(f);
  assert.equal(c.section_week_start,'2030-01-14');assert.equal(c.section_service_date,'2030-01-16');assert.equal(c.section_source,'recurring');
  assert.deepEqual(options(f),['Bone-In Wings','Boneless Wings','','']);
  assert.deepEqual(parseWingSauces(sauces(f)),SAUCES);
  assert.equal(wingWednesdayVisible(c.section_service_date,new Date('2030-01-14T01:00:00Z')),true);
});
for(const [name,pollute] of [['price field',"price='$1.11'"],['item text',"content='Bone-In Wings $1.11'"]]) test(`weekly rollover: a priced default in the ${name} never reaches a week, even written directly`,async t=>{
  const f=rolloverFixture(t);
  f.sql(`UPDATE special_slots SET ${pollute} WHERE group_id='ww-default:wings' AND position=1`);
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  assert.equal(collection(f).section_service_date,null,'stays hidden rather than priced');
  assert.equal(f.sql("SELECT count(*) n FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='wing-wednesday' AND (s.price<>'' OR s.content LIKE '%$%')")[0].n,0);
});
test('weekly rollover: Sunday before 7 PM does not prepare a new week',async t=>{
  const f=rolloverFixture(t);
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:18});
  assert.equal(collection(f).section_service_date,null);
});
test('weekly rollover: same-week rerun keeps staff and Facebook values; next Sunday starts fresh with current defaults',async t=>{
  const f=rolloverFixture(t);
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $1.25 each';
  await store.saveCollection(f.env,live);
  await ensureAutomaticWeek(f.env,{today:'2030-01-15',weekday:2,hour:12});
  assert.equal(options(f)[0],'Bone-In Wings $1.25 each','same-week rerun never reseeds');
  assert.equal(collection(f).section_source,'manual');
  const defaults=await store.readCollection(f.env,'wing-wednesday-defaults');
  defaults.groups[1].slots[0].content='Buffalo\nRanch';
  await store.saveCollection(f.env,defaults);
  assert.equal(options(f)[0],'Bone-In Wings $1.25 each','editing defaults leaves the live week alone');
  await ensureAutomaticWeek(f.env,{today:'2030-01-20',weekday:0,hour:19});
  const c=collection(f);
  assert.equal(c.section_service_date,'2030-01-23');assert.equal(c.section_source,'recurring');
  assert.equal(options(f)[0],'Bone-In Wings','no price carries into the next week');
  assert.equal(sauces(f),'Buffalo\nRanch');
});
test('weekly rollover: an overlapping custom week fails closed and leaves saved data',async t=>{
  const f=rolloverFixture(t);
  addWeek(f,7001,'2030-01-15','2030-01-21');
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  assert.equal(collection(f).section_service_date,null);
  assert.deepEqual(options(f),['Bone-In Wings','Boneless Wings','','']);
});
test('hiding removes nothing: stored values survive past the cutoff',async t=>{
  const f=rolloverFixture(t);
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  const before=[options(f),sauces(f)];
  assert.equal(wingWednesdayVisible(collection(f).section_service_date,new Date('2030-01-17T08:00:00Z')),false);
  assert.deepEqual([options(f),sauces(f)],before);
});

test('verified poster fills prices; sauces, daily slot and audit trail stay as they were',async t=>{
  const f=harness(t,{candidate:wingPoster()});
  await f.run();
  assert.deepEqual(options(f),['Bone-In Wings $.89 each','Boneless Wings $.99 each','','']);
  assert.deepEqual(parseWingSauces(sauces(f)),SAUCES,'a poster without sauces never erases the list');
  assert.equal(collection(f).section_source,'facebook');
  assert.equal(decisions(f)[0].outcome,'published');
  assert.equal(f.slots()[0].content,'Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each','daily automation is unchanged');
  assert.equal(f.state.aiCalls,1,'no extra AI call');
  assert.equal(f.sql("SELECT count(*) n FROM special_import_events WHERE detail LIKE '%WING_WEDNESDAY%'")[0].n,0);
  const revision=collection(f).revision;
  await reconcileWingWednesday(f.env,await scan(f));
  assert.equal(collection(f).revision,revision,'re-running an applied poster changes nothing');
});
test('"Wing Wednesday" heading is accepted with the same price proof, and prices stay with their labels',async t=>{
  const text='Wing Wednesday $.89 Boneless Wings $.99 Bone In Wings';
  const f=harness(t,{candidate:wingPoster(text)});
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings $.99','Boneless Wings $.89']);
});
test('a printed fries line never reaches the section, which stays bone-in and boneless',async t=>{
  const f=harness(t,{candidate:wingPoster('Wing Night Bone-In $.89 each Boneless $.99 each Add Fries $3')});
  await f.run();
  assert.deepEqual(options(f),['Bone-In Wings $.89 each','Boneless Wings $.99 each','','']);
  f.state.posts=[{...f.state.posts[0],id:'p2',created_time:'2030-01-09T14:30:00Z',updated_time:'2030-01-09T14:30:00Z'}];
  f.state.candidate=wingPoster();
  await f.run();
  assert.deepEqual(options(f),['Bone-In Wings $.89 each','Boneless Wings $.99 each','','']);
});

const held=[
  ['missing prices',wingPoster('Wing Night Bone-In Boneless'),/prices/],
  ['one price missing',wingPoster('Wing Night Bone-In $.89 each Boneless'),/prices/,['Bone-In Wings $.89 each','Boneless Wings']],
  ['price disagrees with the evidence',wingPoster(wingText,'Wing Night Bone-In $.79 each / Boneless $.99 each'),/prices/,['Bone-In Wings','Boneless Wings $.99 each']],
  ['two wing offers',poster(3,'Wing Night',[offer(wingText,wingText),offer('Wing Night Bone-In $1 each Boneless $2 each','Wing Night Bone-In $1 each Boneless $2 each')]),/more than one/],
];
for(const [name,candidate,reason,verified] of held) test(`ambiguous poster holds only unverified prices: ${name}`,async t=>{
  const f=harness(t,{candidate});
  await f.run();
  assert.deepEqual(options(f),[...(verified ?? ['Bone-In Wings','Boneless Wings']),'','']);
  assert.equal(collection(f).section_source,verified ? 'facebook' : 'recurring');
  assert.equal(decisions(f)[0].outcome,'held');assert.match(decisions(f)[0].detail,reason);
});
test('poster for another day is held',async t=>{
  const f=harness(t,{candidate:poster(4,'Wing Night',[offer(wingText,wingText)])});
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings','Boneless Wings']);
  assert.match(decisions(f)[0].detail,/does not establish Wednesday/);
});
test('poster with no printed day counts only when posted on Wednesday itself',async t=>{
  const noDay=wingPoster();noDay.day_of_week=-1;noDay.day_evidence='';
  const f=harness(t,{candidate:noDay});
  await f.run();
  assert.equal(options(f)[0],'Bone-In Wings $.89 each');
  const early=harness(t,{candidate:noDay,now:'2030-01-08T15:00:00Z'});
  early.state.posts[0].created_time=early.state.posts[0].updated_time='2030-01-08T14:00:00Z';
  await early.run();
  assert.equal(options(early)[0],'Bone-In Wings');
});
test('a newest poster that must be held leaves the earlier verified prices published',async t=>{
  const f=harness(t,{candidate:wingPoster()});
  await f.run();
  f.state.posts=[{...f.state.posts[0],id:'p2',created_time:'2030-01-09T14:30:00Z',updated_time:'2030-01-09T14:30:00Z'}];
  f.state.candidate=wingPoster('Wing Night Bone-In Boneless');
  await f.run();
  assert.equal(options(f)[0],'Bone-In Wings $.89 each');
  assert.deepEqual(decisions(f).map(d=>d.outcome),['published','held']);
});
test('verified Facebook prices are gone at the next rollover, and the old poster does not refill them',async t=>{
  const f=harness(t,{candidate:wingPoster()});
  await f.run();
  assert.match(options(f)[0],/\$/,'published for its own week');
  // The following Sunday night: the same imports are still in the table.
  f.sql("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(99,'2030-01-14','2030-01-20')");
  f.sql("INSERT INTO special_collections(id,kind,weekly_special_id) VALUES('w99','week',99)");
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  assert.equal(collection(f).section_service_date,'2030-01-16');
  assert.deepEqual(options(f),['Bone-In Wings','Boneless Wings','','']);
  await reconcileWingWednesday(f.env,{...await scan(f),today:'2030-01-13'});
  assert.deepEqual(options(f),['Bone-In Wings','Boneless Wings','','']);
});
test('poster from a prior week never updates the current week',async t=>{
  const f=harness(t,{candidate:wingPoster()});
  await f.run();
  const before=options(f);
  f.sql("UPDATE special_slots SET content='Bone-In Wings',last_auto_value=NULL,origin='manual' WHERE group_id=? AND position=1",OPTIONS);
  f.sql('DELETE FROM wing_wednesday_decisions');
  f.sql("UPDATE special_imports SET fb_created_time='2030-01-02T14:00:00Z'");
  await reconcileWingWednesday(f.env,await scan(f));
  assert.equal(options(f)[0],'Bone-In Wings');assert.notDeepEqual(options(f),before);
  assert.equal(decisions(f).length,0);
});
test('a verified poster replaces a staff price and marks it Facebook-owned',async t=>{
  const f=harness(t,{candidate:wingPoster()});
  await ensureAutomaticWeek(f.env,{today:'2030-01-09',weekday:3,hour:9});
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $1.10 each';
  await store.saveCollection(f.env,live);
  assert.equal(f.sql('SELECT manual_locked FROM special_slots WHERE group_id=? AND position=1',OPTIONS)[0].manual_locked,1);
  await f.run();
  assert.deepEqual(options(f),['Bone-In Wings $.89 each','Boneless Wings $.99 each','','']);
  assert.equal(f.sql('SELECT manual_locked FROM special_slots WHERE group_id=? AND position=1',OPTIONS)[0].manual_locked,0);
  assert.equal(decisions(f)[0].outcome,'published');assert.equal(collection(f).section_source,'facebook');
  assert.equal(f.slots()[0].content,'Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each','the daily slot follows its own rules');
});
test('a staff save racing the poster wins: the revision check stops the whole write',async t=>{
  const f=harness(t,{candidate:wingPoster()});
  await ensureAutomaticWeek(f.env,{today:'2030-01-09',weekday:3,hour:9});
  await f.run();
  const live=await store.readCollection(f.env,'wing-wednesday');
  f.sql('DELETE FROM wing_wednesday_decisions');
  const batch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{
    live.groups[0].slots[1].content='Boneless Wings $2 each';
    f.env.DB.batch=batch;
    await store.saveCollection(f.env,live);
    return batch.call(f.env.DB,statements);
  };
  f.sql("UPDATE special_slots SET content='Bone-In Wings',last_auto_value='Bone-In Wings' WHERE group_id=? AND position=1",OPTIONS);
  const result=await reconcileWingWednesday(f.env,await scan(f));
  assert.equal(result.written,false);
  assert.equal(collection(f).section_source,'manual');
  assert.equal(decisions(f).length,0);
});
test('a failing Wing Wednesday reconcile leaves daily and Mexican Night automation untouched',async t=>{
  const f=harness(t,{candidate:wingPoster()});
  f.sql('DROP TABLE wing_wednesday_decisions');
  await f.run();
  assert.equal(f.slots()[0].content,'Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each');
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings','Boneless Wings']);
});
test('Mexican Night keeps its own rows through a Wing Wednesday rollover',async t=>{
  const f=rolloverFixture(t);
  const before=f.sql("SELECT * FROM special_groups WHERE collection_id LIKE 'mexican-night%'");
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  assert.deepEqual(f.sql("SELECT * FROM special_groups WHERE collection_id LIKE 'mexican-night%'"),before);
});
