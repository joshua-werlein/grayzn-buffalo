// Run npm run build first: exercise the compiled production Astro components.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
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
    assert.equal((html.match(/class="special-group"/g)||[]).length,1);
    if(path==='/specials') { assert.ok(html.includes('id="mexican-night"'));assert.ok(html.includes('SeparateMexicanItem')); }
    else assert.ok(!html.includes('SeparateMexicanItem'));
  }
});

test('Mexican menu merges stored food groups, separates accessories and preserves text and order without writes',async t=>{
  const f=fixture(t);
  const mexican=await s.readCollection(f.env,'mexican-night');
  const entries=[
    ['Mexican Night Favorites',['Burrito - $10.25\nMeat & beans.\n\nExtra salsa.','One line item $9.00']],
    ['More Mexican Night',['Third item','Fourth item']],
    ['Entrees',['Fifth item','Sixth item']],
    ['Unexpected section',['Seventh item']],
    ['Add-Ons',['Add cheese +$1.50']],
    ['Substitutions',['Substitute chicken +$1.50']],
    ['Substitutions & Add-ons',['Substitute queso +$0.50']],
    ['Addons',['Extra salsa +$1.00']],
    ['Substitute',['<script>unsafe()</script>']],
  ];
  mexican.groups=entries.map(([label,items],sort)=>{
    const g=s.blankGroup(-1,sort);g.label=label;g.service_time='5–10 PM';
    g.slots.forEach((slot,i)=>slot.content=items[i]??'');return g;
  });
  await s.saveCollection(f.env,mexican);
  const before=await s.readCollection(f.env,'mexican-night');
  const html=await container.renderToString(publicPage,{request:new Request('http://localhost/specials'),locals:{runtime:{env:f.env}}});
  const food=html.match(/<ul class="menu-grid menu-grid--food"[^>]*>([\s\S]*?)<\/ul>/)[1];
  const extras=html.match(/<ul class="menu-grid menu-grid--extras"[^>]*>([\s\S]*?)<\/ul>/)[1];
  assert.equal((food.match(/<li[ >]/g)||[]).length,7);
  assert.equal((extras.match(/<li[ >]/g)||[]).length,5);
  assert.match(food,/<strong[^>]*>Burrito - \$10.25<\/strong>/);
  assert.match(food,/<p class="menu-item-description"[^>]*>Meat &amp; beans\.\n\nExtra salsa\.<\/p>/);
  assert.match(food,/<strong[^>]*>One line item \$9.00<\/strong>/);
  assert.equal((food.match(/class="menu-item-description"/g)||[]).length,1);
  const titles=[...food.matchAll(/<strong[^>]*>(.*?)<\/strong>/g)].map(m=>m[1]);
  assert.deepEqual(titles,entries.slice(0,4).flatMap(([,items])=>items.map(item=>item.split('\n')[0])));
  assert.ok(extras.indexOf('Add cheese')<extras.indexOf('Substitute chicken'));
  assert.ok(extras.indexOf('Substitute chicken')<extras.indexOf('Substitute queso'));
  assert.doesNotMatch(html,/More Mexican Night|Unexpected section|>Entrees</);
  assert.doesNotMatch(food,/Add cheese|Substitute chicken/);
  assert.match(extras,/&lt;script&gt;unsafe/);
  assert.doesNotMatch(extras,/<script>/);
  assert.ok(html.indexOf('id="mexican-heading"')<html.indexOf('id="mexican-favorites-heading"'));
  assert.ok(html.indexOf('menu-grid--food')<html.indexOf('id="mexican-extras-heading"'));
  assert.match(html,/id="mexican-favorites-heading"[^>]*>Mexican Night Favorites<\/h3>.*?<p[^>]*>5–10 PM<\/p>/s);
  assert.deepEqual(await s.readCollection(f.env,'mexican-night'),before);
});

test('Mexican menu uses one phone column, two tablet columns and four desktop columns without reordering',()=>{
  const component=readFileSync('src/components/MexicanNightMenu.astro','utf8');
  assert.match(component,/\.menu-grid\{[^}]*grid-template-columns:1fr/);
  assert.match(component,/@media\(min-width:681px\)\{\.menu-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(component,/@media\(min-width:1100px\)\{\.menu-grid\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(component,/grid-auto-flow:.*dense|\border\s*:/);
  assert.match(component,/white-space:pre-wrap/);
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

test('compiled simple editor has service-specific inputs, inline prices and no database controls',async t=>{
  const f=fixture(t);f.env.SESSIONS={get:async()=> '1'};
  const week=f.sql('SELECT id FROM weekly_specials LIMIT 1')[0];
  const g=f.sql("SELECT id FROM special_groups WHERE collection_id=(SELECT id FROM special_collections WHERE weekly_special_id=?) AND day_of_week=1 AND service='lunch'",week.id)[0];
  f.sql("UPDATE special_slots SET content='Pizza Bread',price='$9.75' WHERE group_id=? AND position=1",g.id);
  const html=await container.renderToString(adminPage,{request:new Request('http://localhost/admin/specials?week='+week.id,{headers:{cookie:'gb_session='+'a'.repeat(32)}}),locals:{runtime:{env:f.env}}});
  const form=html.match(/<form[^>]*id="weekly-form"[\s\S]*?<\/form>/)[0];
  const fields=[...form.matchAll(/<fieldset class="group-fields"([^>]*)>([\s\S]*?)<\/fieldset>/g)];
  assert.equal(fields.length,21);
  for(const [,attrs,body] of fields) {
    const day=Number(attrs.match(/data-group-day="([^"]*)"/)[1]);
    const service=attrs.match(/data-service="([^"]*)"/)[1];
    const expected=service==='lunch'?1:service==='all-day'?2:[0,6].includes(day)?0:[1,5].includes(day)?2:1;
    assert.equal((body.match(/<textarea /g)||[]).length,expected,`${day} ${service}`);
  }
  assert.match(form,/>Pizza Bread \$9.75<\/textarea>/);
  assert.doesNotMatch(html,/<input[^>]*(?:name="[^"]*_price"|class="import-item-price")/);
  assert.doesNotMatch(form,/Slot [1-4]|data-move|Add service\/group|>Group label/);
  assert.match(form,/Save Week/);
});
