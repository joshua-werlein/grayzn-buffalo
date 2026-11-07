// Run the production build first: these tests exercise the compiled routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
import {ensureAutomaticWeek} from '../workers/fb-feed/auto-week.js';
import {wingWeekFor} from '../src/lib/wing-wednesday.js';
const store=loadTs('src/lib/specials-store.ts');
const page=async name=>(await import(`../dist/_worker.js/pages/${name}.astro.mjs`)).page().default;
const admin=await page('admin/specials'), publicPage=await page('specials'), home=await page('index');
const container=await AstroContainer.create();
const cookie='gb_session='+'a'.repeat(32);
const SUNDAY_NIGHT='2030-01-14T01:00:00Z', WEDNESDAY_NIGHT='2030-01-17T02:00:00Z', THURSDAY_159='2030-01-17T07:59:00Z', THURSDAY_200='2030-01-17T08:00:00Z';
async function setup(t) {
  const f=fixture(t);f.env.SESSIONS={get:async()=> '1'};f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  t.mock.method(Date,'now',()=>Date.parse(SUNDAY_NIGHT));
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  return f;
}
const render=(component,f,now,path='/specials')=>container.renderToString(component,{request:new Request('http://localhost'+path,{headers:{cookie}}),locals:{runtime:{env:f.env,now:new Date(now)}}});
const section=html=>html.match(/<article class="placard placard--wing[\s\S]*?<\/article>/)?.[0];
function bodyFor(collection,action) {
  const body=new FormData();
  if(action==='save-wing-wednesday') body.set('wing_week',wingWeekFor(new Date(Date.now())).weekStart);
  for(const [key,value] of Object.entries({action,revision:collection.revision,group_count:collection.groups.length,title:collection.title,schedule:collection.schedule})) body.set(key,String(value));
  collection.groups.forEach((g,i)=>{
    for(const [key,value] of Object.entries({id:g.id,day:g.day_of_week,service:g.service,label:g.label,time:g.service_time,enabled:'on'})) body.set(`g${i}_${key}`,String(value));
    const sauces=g.id.endsWith('ww-default:sauces');
    for(const slot of g.slots) {
      if(sauces) { body.set(`g${i}_${slot.position}_content`,slot.content??''); continue; }
      const [title,...rest]=(slot.content??'').split('\n');
      body.set(`g${i}_${slot.position}_title`,title);body.set(`g${i}_${slot.position}_description`,rest.join('\n'));
    }
  });return body;
}
const post=(f,body)=>container.renderToResponse(admin,{request:new Request('http://localhost/admin/specials',{
  method:'POST',headers:{origin:'http://localhost',cookie,accept:'application/json'},body,
}),locals:{runtime:{env:f.env}}});

test('an unchanged editor save leaves a Facebook price unmarked; the editor offers no price protection',async t=>{
  const f=await setup(t);
  const read=()=>store.readCollection(f.env,'wing-wednesday');
  const slot=async()=>(await read()).groups[0].slots[0];
  f.sql("UPDATE special_slots SET content='Bone-In Wings $.89 each',last_auto_value='Bone-In Wings $.89 each',origin='automation' WHERE group_id='ww-live:ww-default:wings' AND position=1");
  assert.equal((await post(f,bodyFor(await read(),'save-wing-wednesday'))).status,200);
  assert.equal((await slot()).manual_locked,0);
  const html=await render(admin,f,WEDNESDAY_NIGHT,'/admin/specials');
  assert.doesNotMatch(html,/protect_price|Protect this price/);
  const ignored=bodyFor(await read(),'save-wing-wednesday');
  ignored.set('g0_1_protect_price','on');
  assert.equal((await post(f,ignored)).status,200);
  assert.equal((await slot()).manual_locked,0,'an old form cannot set it');
  const clear=bodyFor(await read(),'save-wing-wednesday');
  clear.set('g0_1_title','Bone-In Wings');
  assert.equal((await post(f,clear)).status,200);
  assert.equal((await slot()).manual_locked,0);
  assert.equal((await slot()).content,'Bone-In Wings');
});

test('public section shows both options and all sauces without prices or invented offers',async t=>{
  const f=await setup(t);
  const html=section(await render(publicPage,f,WEDNESDAY_NIGHT));
  assert.match(html,/id="wing-title"[^>]*>Wing Wednesday</);
  assert.match(html,/Bone-In Wings/);assert.match(html,/Boneless Wings/);
  assert.doesNotMatch(html,/\$|\d+\s*(?:pc|piece|ct|count)/i);
  const sauces=[...html.matchAll(/<li[^>]*>([^<]+)<\/li>/g)].map(m=>m[1].replace('&amp;','&'));
  assert.equal(sauces.length,16);
  for(const sauce of ['Sweet & Sour','Jack BBQ','Boom Boom','Garlic Parmesan','Signature']) assert.ok(sauces.includes(sauce),sauce);
  assert.match(html,/this week’s prices/);
});
test('the price note stays until both options have a price',async t=>{
  const f=await setup(t);
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $1.25 each';
  await store.saveCollection(f.env,live);
  assert.match(section(await render(publicPage,f,WEDNESDAY_NIGHT)),/this week’s prices/);
  const again=await store.readCollection(f.env,'wing-wednesday');
  again.groups[0].slots[1].content='Boneless Wings $1.35 each';
  await store.saveCollection(f.env,again);
  const html=section(await render(publicPage,f,WEDNESDAY_NIGHT));
  assert.match(html,/\$1\.25 each/);assert.doesNotMatch(html,/this week’s prices/);
});
test('section and anchors appear through Wednesday night and hide at 2 AM Thursday; data remains',async t=>{
  const f=await setup(t);const before=await store.readCollection(f.env,'wing-wednesday');
  for(const now of [SUNDAY_NIGHT,WEDNESDAY_NIGHT,THURSDAY_159]) {
    const html=await render(publicPage,f,now);
    assert.ok(section(html),now);assert.match(html,/id="wing-wednesday"/);assert.match(html,/<a href="#wing-wednesday"[^>]*>Wing Wednesday/);
  }
  const hidden=await render(publicPage,f,THURSDAY_200);
  assert.equal(section(hidden),undefined);assert.doesNotMatch(hidden,/href="#wing-wednesday"/);
  assert.match(hidden,/Wing Wednesday/,'the recurring card stays, unlinked');
  assert.deepEqual(await store.readCollection(f.env,'wing-wednesday'),before);
});
test('a staff edit after the cutoff does not reopen last week\'s section',async t=>{
  const f=await setup(t);
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $1 each';
  await store.saveCollection(f.env,live);
  assert.equal(section(await render(publicPage,f,'2030-01-18T18:00:00Z')),undefined);
});
test('homepage Wednesday card links to the section only while it is visible',async t=>{
  const f=await setup(t);
  f.sql("UPDATE special_slots SET content='Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each' WHERE position=1 AND group_id IN (SELECT g.id FROM special_groups g JOIN special_collections c ON c.id=g.collection_id WHERE c.kind='week' AND g.day_of_week=3 AND g.service='nightly')");
  const link=/href="\/specials#wing-wednesday"/;
  // The board picks its days from the real clock, so move it to each instant.
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2030-01-16T18:00:00Z')});
  assert.match(await render(home,f,'2030-01-16T18:00:00Z','/'),link);
  t.mock.timers.setTime(Date.parse(WEDNESDAY_NIGHT));
  assert.match(await render(home,f,WEDNESDAY_NIGHT,'/'),link);
  // Thursday: next Wednesday's date is still on the 7-day board, but the section is hidden.
  t.mock.timers.setTime(Date.parse(THURSDAY_200));
  assert.doesNotMatch(await render(home,f,THURSDAY_200,'/'),link);
});
test('admin shows Wing Wednesday editors immediately below Mexican Night with unique IDs',async t=>{
  const f=await setup(t);
  const html=await render(admin,f,WEDNESDAY_NIGHT,'/admin/specials');
  const order=['id="mexican-defaults-form"','id="mexican-form"','id="wing-defaults-form"','id="wing-form"','id="special-events"'].map(id=>html.indexOf(id));
  assert.ok(order.every((at,i)=>at>=0 && (i===0 || at>order[i-1])),String(order));
  const form=html.match(/<form[^>]*id="wing-form"[\s\S]*?<\/form>/)[0];
  assert.match(form,/Sweet Chili\nBBQ/);assert.match(form,/value="save-wing-wednesday"/);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length);
});
for(const recurring of [true,false]) test(`admin ${recurring?'recurring':'live'} POST saves only its own collection`,async t=>{
  const f=await setup(t);const id=recurring?'wing-wednesday-defaults':'wing-wednesday';
  const other=recurring?'wing-wednesday':'wing-wednesday-defaults';
  const before=await store.readCollection(f.env,other);const mexican=await store.readCollection(f.env,'mexican-night');
  const body=bodyFor(await store.readCollection(f.env,id),recurring?'save-wing-wednesday-defaults':'save-wing-wednesday');
  body.set('g0_1_title',recurring?'Bone-In Wings':'Bone-In Wings $1.25 each');body.set('g0_1_description','Staff description');
  body.set('g1_1_content','Buffalo\r\nRanch');
  const response=await post(f,body);assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
  const saved=await store.readCollection(f.env,id);
  assert.match(saved.groups[0].slots[0].content,recurring?/^Bone-In Wings\nStaff description$/:/^Bone-In Wings \$1\.25 each\nStaff description$/);
  assert.equal(saved.groups[1].slots[0].content,'Buffalo\nRanch');
  assert.deepEqual(await store.readCollection(f.env,other),before);
  assert.deepEqual(await store.readCollection(f.env,'mexican-night'),mexican);
  assert.equal(f.sql('SELECT section_source FROM special_collections WHERE id=?',id)[0].section_source,recurring?null:'manual');
});
// Sunday afternoon: last week's section still holds last week's published prices.
async function lastWeekPublished(t) {
  const f=fixture(t);f.env.SESSIONS={get:async()=> '1'};f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  const clock=t.mock.method(Date,'now',()=>Date.parse('2030-01-07T01:00:00Z'));
  await ensureAutomaticWeek(f.env,{today:'2030-01-06',weekday:0,hour:19});
  f.sql("UPDATE special_slots SET content='Bone-In Wings $.89 each',origin='automation',last_auto_value='Bone-In Wings $.89 each' WHERE group_id='ww-live:ww-default:wings' AND position=1");
  f.sql("UPDATE special_slots SET content='Add Fries $3',origin='automation',last_auto_value='Add Fries $3' WHERE group_id='ww-live:ww-default:wings' AND position=3");
  f.sql("UPDATE special_collections SET section_source='facebook' WHERE id='wing-wednesday'");
  clock.mock.mockImplementation(()=>Date.parse('2030-01-13T20:00:00Z'));
  return f;
}
const SUNDAY_AFTERNOON=new Date('2030-01-13T20:00:00Z');
const liveOptions=f=>f.sql("SELECT position,content,origin,manual_locked,last_auto_value,manual_edited_at FROM special_slots WHERE group_id='ww-live:ww-default:wings' ORDER BY position");
test('a Sunday sauce-only save from the editor claims the week, drops last week\'s prices and leaves the options open to Facebook',async t=>{
  const f=await lastWeekPublished(t);
  const shown=store.wingEditorValues(await store.readCollection(f.env,'wing-wednesday'),await store.readCollection(f.env,'wing-wednesday-defaults'),'2030-01-07',SUNDAY_AFTERNOON);
  shown.groups.find(g=>g.id.endsWith('sauces')).slots[0].content='Buffalo\nRanch';
  const reply=await post(f,bodyFor(shown,'save-wing-wednesday'));
  assert.equal(reply.status,200);
  const row=f.sql("SELECT section_source,section_week_start FROM special_collections WHERE id='wing-wednesday'")[0];
  assert.deepEqual({...row},{section_source:'recurring',section_week_start:'2030-01-14'});
  const slots=liveOptions(f);
  assert.equal(slots[0].content,'Bone-In Wings');assert.equal(slots[2].content,'');
  for(const slot of slots) assert.deepEqual({origin:slot.origin,locked:slot.manual_locked,auto:slot.last_auto_value,edited:slot.manual_edited_at},{origin:'manual',locked:0,auto:null,edited:null});
  assert.equal(f.sql("SELECT content FROM special_slots WHERE group_id='ww-live:ww-default:sauces' AND position=1")[0].content,'Buffalo\nRanch');
});
test('a Sunday price typed into the editor is kept for the coming week as a staff entry',async t=>{
  const f=await lastWeekPublished(t);
  const shown=store.wingEditorValues(await store.readCollection(f.env,'wing-wednesday'),await store.readCollection(f.env,'wing-wednesday-defaults'),'2030-01-07',SUNDAY_AFTERNOON);
  shown.groups.find(g=>g.id.endsWith('wings')).slots[0].content='Bone-In Wings $.89 each';
  shown.groups.find(g=>g.id.endsWith('wings')).slots[1].content='Boneless Wings $1 each';
  const reply=await post(f,bodyFor(shown,'save-wing-wednesday'));
  assert.equal(reply.status,200);
  assert.equal(f.sql("SELECT section_source FROM special_collections WHERE id='wing-wednesday'")[0].section_source,'manual');
  assert.equal(liveOptions(f)[1].manual_locked,1);
  assert.equal(liveOptions(f)[0].manual_locked,1,'retyping last week\'s price is still a staff entry');
  assert.equal(liveOptions(f)[0].last_auto_value,null);
});
test('a tab opened for an earlier week cannot save last week\'s prices into the coming week',async t=>{
  const f=await lastWeekPublished(t);
  const stale=await store.readCollection(f.env,'wing-wednesday');
  const before=liveOptions(f);
  const body=bodyFor(stale,'save-wing-wednesday');body.set('wing_week','2030-01-07');
  const reply=await post(f,body);
  assert.equal(reply.status,409);
  assert.deepEqual(liveOptions(f),before);
  assert.equal(f.sql("SELECT section_week_start FROM special_collections WHERE id='wing-wednesday'")[0].section_week_start,'2030-01-07');
});
test('the Wing editor has an item name field and no price input; Mexican Night keeps its label',async t=>{
  const f=await setup(t);
  const html=await render(admin,f,WEDNESDAY_NIGHT,'/admin/specials');
  const form=id=>html.match(new RegExp(`<form[^>]*id="${id}"[\\s\\S]*?</form>`))[0];
  const wing=form('wing-form');
  assert.match(wing,/Item name<input/);assert.doesNotMatch(wing,/Item \/ price/);
  assert.doesNotMatch(wing,/name="[^"]*price[^"]*"/i,'no dedicated price input');
  assert.match(wing,/Description \(optional\)/);
  assert.match(form('wing-defaults-form'),/Item name \/ sizes \(no prices\)/);
  assert.match(form('mexican-form'),/Item \/ price/);
});
test('saving a price typed into the item name keeps it, with no price field involved',async t=>{
  const f=await setup(t);
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $1.25 each';
  const reply=await post(f,bodyFor(live,'save-wing-wednesday'));
  assert.equal(reply.status,200);
  assert.equal(liveOptions(f)[0].content,'Bone-In Wings $1.25 each');assert.equal(liveOptions(f)[0].manual_locked,1);
  assert.equal(liveOptions(f)[1].manual_locked,0);
});
test('recurring defaults reject prices anywhere, including sauces',async t=>{
  const f=await setup(t);const defaults=await store.readCollection(f.env,'wing-wednesday-defaults');
  for(const edit of [body=>body.set('g0_1_title','Bone-In Wings $1 each'),body=>body.set('g1_1_content','Buffalo $1')]) {
    const body=bodyFor(defaults,'save-wing-wednesday-defaults');edit(body);
    const response=await post(f,body);assert.equal(response.status,400);
    assert.match((await response.json()).error,/Recurring Wing Wednesday defaults cannot include prices/);
  }
  assert.deepEqual(await store.readCollection(f.env,'wing-wednesday-defaults'),defaults);
});
test('admin shows a held poster notice; a published one does not',async t=>{
  const f=await setup(t);
  f.sql("INSERT INTO special_imports(id,fb_post_id,fb_created_time,caption,caption_hash,permalink_url,target_kind,classification_reason,processing_status,fetched_at,parser_version) VALUES('held-1','p','2030-01-16T14:00:00Z','','h','https://facebook.example/p','ignored','','staged','2030-01-16T14:00:00Z',19)");
  f.sql("INSERT INTO wing_wednesday_decisions(import_id,week_start,outcome,detail) VALUES('held-1','2030-01-14','held','Missing, malformed or ambiguous wing prices')");
  assert.match(await render(admin,f,WEDNESDAY_NIGHT,'/admin/specials'),/Facebook poster held for review: Missing, malformed/);
  f.sql("UPDATE wing_wednesday_decisions SET outcome='published'");
  assert.doesNotMatch(await render(admin,f,WEDNESDAY_NIGHT,'/admin/specials'),/Facebook poster held for review/);
});
test('a Facebook decision records only published, held or approved',async t=>{
  const f=await setup(t);
  f.sql("INSERT INTO special_imports(id,fb_post_id,fb_created_time,caption,caption_hash,permalink_url,target_kind,classification_reason,processing_status,fetched_at,parser_version) VALUES('old-outcome','old-outcome','2030-01-16T14:00:00Z','','h','https://facebook.example/old-outcome','ignored','','staged','2030-01-16T14:00:00Z',19)");
  assert.throws(()=>f.sql("INSERT INTO wing_wednesday_decisions(import_id,week_start,outcome,detail) VALUES('old-outcome','2030-01-14','protected','')"),/CHECK/);
});
