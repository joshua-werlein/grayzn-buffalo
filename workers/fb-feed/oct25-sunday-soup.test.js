import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyzeDailyEvidence} from './evidence.js';
import {reconcilePosterEvidence} from './reconcile.js';
import {standaloneSoup,soupGroupId} from '../../src/lib/daily-soup.js';
import {reconcileToday} from './guarded-auto.js';
import {harness} from './test-fixture.js';

// Public poster transcriptions only (stored October 25 extractions). The
// SUNDAY SPECIALS poster prints "Soups: Chicken Noodle or Chili." with a
// sentence period the model kept in evidence but not in content. The later
// Packers $4 pulled pork poster is a special event, out of scope here.
const {sunday_specials:sundayRaw,packers_event:packersRaw}=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct25-sunday-soup.json',import.meta.url),'utf8'));
const stored=(raw,edit=p=>p)=>{const p=structuredClone(raw);edit(p);return analyzeDailyEvidence(p);};
const SOUP='Chicken Noodle or Chili';
const FOOD={lunch:['16” 3-Topping Pizza & 12 Wings $30'],
  'all-day':['HANG OVER BURGER w/ SIDE SALAD, SOUP OR COLESLAW $10.25','GRILLED HAM AND CHEESE w/ CUP OF SOUP OR COLESLAW $7.25']};
const route=(candidates,{day=0,today='2026-10-25'}={})=>reconcilePosterEvidence(candidates,day,[],{today,verifiedSameDaySources:new Set(candidates.map((_,i)=>i))});
const items=(r,service)=>r.targets.find(t=>(t.role??t.service)===service)?.items.map(i=>i.content);

test('production October 25: stored candidate is free of the soup issue and plans the soup beside unchanged food',()=>{
  const sunday=stored(sundayRaw);
  assert.ok(!sunday.issues.some(i=>i.reason==='Ambiguous standalone Soup evidence'));
  const r=route([sunday]);
  assert.deepEqual(items(r,'soup'),[SOUP]);
  assert.deepEqual(r.targets.find(t=>t.role==='soup').service,'custom');
  assert.deepEqual(items(r,'lunch'),FOOD.lunch);assert.deepEqual(items(r,'all-day'),FOOD['all-day']);
  assert.deepEqual(r.unresolvedTargets,[]);
});

test('the Packers special-event poster neither blocks nor joins the soup, in either order',()=>{
  for(const candidates of [[stored(sundayRaw),stored(packersRaw)],[stored(packersRaw),stored(sundayRaw)]]) {
    const r=route(candidates);
    assert.deepEqual(items(r,'soup'),[SOUP]);
    assert.ok(!r.targets.flatMap(t=>t.items).some(i=>/pulled pork/i.test(i.content)));
  }
});

test('only one terminal sentence mark is presentation; names, connectors and omissions still must match',()=>{
  const soup=(content,evidence)=>standaloneSoup({content,evidence,service_time:''});
  assert.equal(soup('Soups: Chicken Noodle or Chili','Soups: Chicken Noodle or Chili.'),SOUP);
  assert.equal(soup('Soups: Chicken Noodle or Chili.','Soups: Chicken Noodle or Chili'),SOUP);
  assert.equal(soup('Soup: Chili!','Soup: Chili'),'Chili');
  assert.equal(soup('Soups: Chicken Noodle, Chili and Beef Barley','Soups: Chicken Noodle, Chili and Beef Barley.'),'Chicken Noodle, Chili and Beef Barley');
  for(const [content,evidence] of [
    ['Soups: Chicken Noodle or Chili','Soups: Chicken Noodle or Chili..'],
    ['Soups: Chicken Noodle','Soups: Chicken Noodle or Chili.'],
    ['Soups: Chicken Noodle and Chili','Soups: Chicken Noodle or Chili.'],
    ['Soups: Chicken Noodle or','Soups: Chicken Noodle or.'],
    ['Soups: .','Soups: .'],
    ['Soups: Chili $4','Soups: Chili $4.'],
    ['Soups: Chili with crackers','Soups: Chili with crackers.'],
  ]) assert.equal(soup(content,evidence),null,`${content} | ${evidence}`);
});

test('soup is held when the poster dates itself to another day',()=>{
  const saturday=stored(sundayRaw,p=>{p.day_of_week=6;p.day_evidence='SATURDAY';p.poster_evidence='SATURDAY SPECIALS';});
  assert.ok(!items(route([saturday]),'soup'));
  const future=stored(sundayRaw,p=>{p.offers[3].date_evidence='10/26';});
  assert.ok(!items(route([future]),'soup'));
});

function setup(t) {
  const f=harness(t,{now:'2026-10-25T14:29:01.923Z',candidate:structuredClone(sundayRaw)});
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-19',week_end_date='2026-10-25' WHERE id=9000");
  Object.assign(f.state.posts[0],{id:'sunday',created_time:'2026-10-25T09:27:36-05:00',updated_time:'2026-10-25T09:27:36-05:00'});
  Object.assign(f.env,{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'});
  const soupRows=day=>f.sql('SELECT * FROM special_slots WHERE group_id=? ORDER BY position',soupGroupId('auto-week',day));
  const food=()=>({lunch:f.slots(0,'lunch').filter(s=>s.content).map(s=>s.content),'all-day':f.slots(0,'all-day').filter(s=>s.content).map(s=>s.content)});
  return {...f,soupRows,food};
}

test('pipeline: Sunday soup publishes into the reserved Soup group, food slots unchanged, idempotent, other days untouched',async t=>{
  const f=setup(t);await f.run();
  const soup=f.soupRows(0);
  assert.equal(soup[0].content,SOUP);assert.equal(soup[0].origin,'automation');assert.equal(soup[0].last_auto_value,SOUP);
  assert.ok(soup.slice(1).every(s=>!s.content),'one Soup value, no extra slots');
  assert.deepEqual(f.food(),FOOD);
  assert.ok(!f.sql('SELECT group_id,content FROM special_slots').some(s=>s.content===SOUP && !s.group_id?.startsWith('soup:')),'soup never occupies a food slot');
  for(const day of [1,2,3,4,5,6]) assert.ok(f.soupRows(day).every(s=>!s.content),`day ${day}`);
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),calls=f.state.aiCalls;
  f.state.now+=30*60000;await f.run();
  assert.equal(f.state.aiCalls,calls);
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
});

test('pipeline: the later Packers event post leaves the soup and food in place and is not published',async t=>{
  const f=setup(t);await f.run();
  f.state.now=Date.parse('2026-10-25T15:35:08.068Z');f.state.candidate=structuredClone(packersRaw);
  f.state.posts.push({...f.state.posts[0],id:'packers',created_time:'2026-10-25T10:33:50-05:00',updated_time:'2026-10-25T10:33:50-05:00'});
  await f.run();
  assert.equal(f.soupRows(0)[0].content,SOUP);assert.deepEqual(f.food(),FOOD);
  assert.ok(!f.sql('SELECT content FROM special_slots').some(s=>/pulled pork/i.test(s.content??'')));
});

test('pipeline: a stored Facebook time outside today cannot publish the soup',async t=>{
  for(const time of ['2026-10-24T22:00:00+0000','2026-10-25T20:00:00+0000','invalid']) {
    const f=setup(t);f.env.SPECIALS_IMPORT_MODE='DRY_RUN';await f.run();
    f.sql('UPDATE special_imports SET fb_created_time=?',time);
    const r=await reconcileToday(f.env,{sourceIds:f.imports().map(i=>i.id),today:'2026-10-25',weekday:0});
    assert.equal(r.written,false,time);assert.ok(f.soupRows(0).every(s=>!s.content),time);
  }
});

test('pipeline: staff-locked Sunday soup is never replaced; the block is audited',async t=>{
  const f=setup(t);const id=soupGroupId('auto-week',0);
  f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled) VALUES(?,'auto-week',0,'custom','Soup','',99,1)",id);
  for(const position of [1,2,3,4]) f.sql("INSERT INTO special_slots(group_id,position,content,origin,manual_locked) VALUES(?,?,?,'manual',?)",id,position,position===1?'Staff: Beef Barley':'',position===1?1:0);
  await f.run();
  assert.equal(f.soupRows(0)[0].content,'Staff: Beef Barley');
  assert.deepEqual(f.food(),FOOD);
  assert.ok(f.sql("SELECT detail FROM special_import_events WHERE event_type='review'").some(e=>e.detail.includes('GUARDED_AUTO_CONFLICT')));
});
