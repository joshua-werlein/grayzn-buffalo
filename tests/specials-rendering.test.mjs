// Run npm run build first: exercise the compiled production Astro components.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
const s=loadTs('src/lib/specials-store.ts');
const dates=loadTs('src/lib/weekly-specials.ts');
const groupModule=await import('../dist/_worker.js/chunks/'+readdirSync('dist/_worker.js/chunks').find(name=>name.startsWith('SpecialGroup_')));
const publicPage=(await import('../dist/_worker.js/pages/specials.astro.mjs')).page().default;
const homePage=(await import('../dist/_worker.js/pages/index.astro.mjs')).page().default;
const adminPage=(await import('../dist/_worker.js/pages/admin/specials.astro.mjs')).page().default;
const container=await AstroContainer.create();
test('compiled shared renderer emits exactly 0–4 populated items and escapes imported-looking markup',async()=>{
  for(let count=0;count<=4;count++) {
    const group=s.blankGroup(1);group.label='Nightly';group.slots.forEach((slot,i)=>slot.content=i<count ? `Offer-${i}`:'');
    const html=await container.renderToString(groupModule.$,{props:{group}});
    assert.equal((html.match(/<li[ >]/g)||[]).length,count);
    if(!count) assert.equal(html.trim(),'');
  }
  const group=s.blankGroup(5);group.label='Nightly';group.slots[0].content='<script>bad()</script>';
  const html=await container.renderToString(groupModule.$,{props:{group}});
  assert.ok(!html.includes('<script>bad'));assert.ok(html.includes('&lt;script&gt;'));
});
test('homepage and specials hide empty days/groups, render four items and keep Mexican Night separate',async t=>{
  const f=fixture(t);f.sql("UPDATE special_slots SET content='',price='',section_link=''");
  const today=dates.chicagoCalendarDate();
  let row=f.sql('SELECT id FROM weekly_specials WHERE week_start_date<=? AND week_end_date>=?',today,today)[0];
  if(!row) {
    const week=s.newWeekFromDefaults(await s.readCollection(f.env,'defaults'));
    const start=dates.mondayForIsoDate(today);
    row=await s.saveCollection(f.env,week,{start,end:dates.standardWeekEndDate(start)});
  }
  const week=await s.readWeek(f.env,row.id);
  const group=week.collection.groups.find(g=>g.day_of_week===dates.calendarDayOfWeek(today) && g.service==='lunch');
  group.slots.forEach((slot,i)=>slot.content=`VisibleSpecial${i+1}`);
  group.slots[0].section_link='mexican-night';
  await s.saveCollection(f.env,week.collection,{start:week.week_start_date,end:week.week_end_date});
  const mexican=await s.readCollection(f.env,'mexican-night');const menu=s.blankGroup(-1);menu.label='Test menu';menu.slots[0].content='SeparateMexicanItem';mexican.groups=[menu];await s.saveCollection(f.env,mexican);
  for(const [component,path] of [[publicPage,'/specials'],[homePage,'/']]) {
    const html=await container.renderToString(component,{request:new Request('http://localhost'+path),locals:{runtime:{env:f.env}}});
    for(let i=1;i<=4;i++) assert.ok(html.includes(`VisibleSpecial${i}`));
    assert.ok(!html.includes('No special posted.'));
    assert.ok(html.includes('/specials#mexican-night'));
    assert.equal((html.match(/class="special-group"/g)||[]).length,path==='/' ? 1:2);
    if(path==='/specials') { assert.ok(html.includes('id="mexican-night"'));assert.ok(html.includes('SeparateMexicanItem')); }
    else assert.ok(!html.includes('SeparateMexicanItem'));
  }
});
test('compiled admin preserves drafts on stale POST and rejects wrong origin without writes',async t=>{
  const f=fixture(t);f.env.SESSIONS={get:async()=> '1'};
  const weekRow=f.sql('SELECT * FROM weekly_specials LIMIT 1')[0];const week=await s.readWeek(f.env,weekRow.id);
  function form() {
    const body=new FormData();body.set('action','save-weekly-specials');body.set('weekly_id',String(week.id));body.set('revision',String(week.collection.revision));body.set('week_start_date',week.week_start_date);body.set('group_count',String(week.collection.groups.length));body.set('weekly_active_day','6');
    week.collection.groups.forEach((g,i)=>{for(const [key,value] of Object.entries({id:g.id,day:g.day_of_week,service:g.service,label:g.label,time:g.service_time,enabled:'on'})) body.set(`g${i}_${key}`,String(value));for(const slot of g.slots) for(const [key,value] of Object.entries({content:slot.content,price:slot.price,link:slot.section_link})) body.set(`g${i}_${slot.position}_${key}`,value??'');});
    body.set('g0_1_content','UnsavedBartenderDraft');return body;
  }
  const request=(origin)=>new Request('http://localhost/admin/specials?week='+week.id,{method:'POST',headers:{origin,cookie:'gb_session='+'a'.repeat(32)},body:form()});
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  const rejected=await container.renderToString(adminPage,{request:request('https://wrong.example'),locals:{runtime:{env:f.env}}});
  assert.ok(rejected.includes('Invalid request origin'));
  f.sql('UPDATE special_collections SET revision=revision+1 WHERE id=?',week.collection.id);
  const html=await container.renderToString(adminPage,{request:request('http://localhost'),locals:{runtime:{env:f.env}}});
  assert.ok(html.includes('UnsavedBartenderDraft'));assert.ok(html.includes('changed after you opened'));
  assert.ok(html.includes('data-active-day="6"'));assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
});
