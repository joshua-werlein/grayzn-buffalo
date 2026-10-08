import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
import {withSoupControls,isSoupGroup,soupGroupId,blankSoupGroup} from '../src/lib/daily-soup.js';
const s=loadTs('src/lib/specials-store.ts');
const dates=loadTs('src/lib/weekly-specials.ts');
const rendererModule=await import('../dist/_worker.js/chunks/'+readdirSync('dist/_worker.js/chunks').find(n=>n.startsWith('DailySoup_') || n.startsWith('SpecialGroup_')));
const soupModule={$:Object.values(rendererModule).find(component=>component.moduleId?.endsWith('/DailySoup.astro'))};
const publicPage=(await import('../dist/_worker.js/pages/specials.astro.mjs')).page().default;
const homePage=(await import('../dist/_worker.js/pages/index.astro.mjs')).page().default;
const adminPage=(await import('../dist/_worker.js/pages/admin/specials.astro.mjs')).page().default;
const privacyPage=(await import('../dist/_worker.js/pages/privacy.astro.mjs')).page().default;
const container=await AstroContainer.create();
function formFor(c) {
  const form=new FormData();form.set('revision',String(c.revision));form.set('group_count',String(c.groups.length));
  c.groups.forEach((g,i)=>{
    for(const [key,value]of Object.entries({id:g.id,day:g.day_of_week,service:g.service,label:g.label,time:g.service_time}))form.set(`g${i}_${key}`,String(value));
    if(isSoupGroup(g)){if(!g.enabled)form.set(`g${i}_hide`,'on');}else if(g.enabled)form.set(`g${i}_enabled`,'on');
    g.slots.forEach(slot=>form.set(`g${i}_${slot.position}_content`,slot.content??''));
  });return form;
}
async function weekFor(f) {
  const today=dates.chicagoCalendarDate(),start=dates.mondayForIsoDate(today);
  const id=await s.currentSavedWeekId(f.env);
  if(id)return s.readWeek(f.env,id);
  const saved=await s.saveCollection(f.env,s.newWeekFromDefaults(await s.readCollection(f.env,'defaults')),{start,end:dates.standardWeekEndDate(start)});
  return s.readWeek(f.env,saved.id);
}
const save=(f,w,c)=>s.saveCollection(f.env,c,{start:w.week_start_date,end:w.week_end_date});

test('reserved Soup renderer emits no placeholder and escapes one compact line',async()=>{
  const group=blankSoupGroup('week',3);
  for(const content of ['', ' ', '\n']){group.slots[0].content=content;assert.equal((await container.renderToString(soupModule.$,{props:{groups:[group]}})).trim(),'');}
  group.slots[0].content='French Onion or Chili';
  const html=await container.renderToString(soupModule.$,{props:{groups:[group]}});
  assert.equal((html.match(/class="daily-soup"/g)||[]).length,1);assert.match(html,/<strong[^>]*>Soup:<\/strong> French Onion or Chili/);assert.doesNotMatch(html,/<section/);
  group.enabled=0;assert.equal((await container.renderToString(soupModule.$,{props:{groups:[group]}})).trim(),'');
  group.enabled=1;group.slots[0].content='<img src=x onerror=alert(1)>';
  assert.match(await container.renderToString(soupModule.$,{props:{groups:[group]}}),/&lt;img/);
  assert.match(readFileSync('src/components/DailySoup.astro','utf8'),/overflow-wrap:anywhere/);
});
test('homepage and Specials render Soup once outside meal sections; absent/disabled hides completely',async t=>{
  const f=fixture(t);f.sql("UPDATE special_slots SET content='',price='',section_link=''");
  let w=await weekFor(f),c=withSoupControls(w.collection);const day=dates.calendarDayOfWeek(dates.chicagoCalendarDate());
  const soup=c.groups.find(g=>isSoupGroup(g)&&g.day_of_week===day);soup.slots[0].content='French Onion or Chili';
  const allDay=c.groups.find(g=>g.day_of_week===day&&g.service==='all-day');allDay.slots[0].content='Sandwich with Soup or Coleslaw';
  await save(f,w,c);
  for(const [page,path]of [[homePage,'/'],[publicPage,'/specials']]){
    const html=await container.renderToString(page,{request:new Request('http://localhost'+path),locals:{runtime:{env:f.env}}});
    assert.equal((html.match(/class="daily-soup"/g)||[]).length,1);assert.equal((html.match(/French Onion or Chili/g)||[]).length,1);
    assert.equal((html.match(/class="special-group"/g)||[]).length,1);assert.match(html,/Sandwich with Soup or Coleslaw/);
  }
  w=await s.readWeek(f.env,w.id);c=w.collection;c.groups.find(g=>isSoupGroup(g)&&g.day_of_week===day).enabled=0;await save(f,w,c);
  for(const page of [homePage,publicPage]){
    const html=await container.renderToString(page,{request:new Request('http://localhost/'),locals:{runtime:{env:f.env}}});
    assert.doesNotMatch(html,/class="daily-soup"|French Onion or Chili/);
  }
});
test('admin adds seven weekly and recurring optional controls without read-time writes or extra Soup slots',async t=>{
  const f=fixture(t);f.env.SESSIONS={get:async()=> '1'};const w=await weekFor(f);const before=f.sql('SELECT * FROM special_groups ORDER BY id');
  const html=await container.renderToString(adminPage,{request:new Request('http://localhost/admin/specials?week='+w.id,{headers:{cookie:'gb_session='+'a'.repeat(32)}}),locals:{runtime:{env:f.env}}});
  const form=html.match(/<form[^>]*id="weekly-form"[\s\S]*?<\/form>/)[0];
  assert.equal((form.match(/Soup today — optional/g)||[]).length,7);assert.equal((form.match(/Keep Soup hidden today/g)||[]).length,7);
  const defaults=html.match(/<form[^>]*id="recurring-defaults-form"[\s\S]*?<\/form>/)[0];assert.doesNotMatch(defaults,/Soup today|_hide/);
  assert.equal((defaults.match(/Soup — optional/g)||[]).length,7);
  const fields=defaults.match(/<fieldset[^>]*>[\s\S]*?<\/fieldset>/g).filter(field=>field.includes('Soup — optional'));
  assert.ok(fields.every(field=>(field.match(/<textarea/g)||[]).length===1 && !field.includes('type="checkbox"')));
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,new Set(ids).size);
  const names=[...defaults.matchAll(/\bname="(g\d+_[^"]+)"/g)].map(match=>match[1]);assert.equal(names.length,new Set(names).size);
  assert.deepEqual(f.sql('SELECT * FROM special_groups ORDER BY id'),before);
});
test('server parsing ignores forged Soup identity/ownership; manual edits lock and unchanged automation stays owned',async t=>{
  const f=fixture(t),w=await weekFor(f);let c=withSoupControls(w.collection),form=formFor(c);
  let g=c.groups.find(g=>isSoupGroup(g)&&g.day_of_week===3),i=c.groups.indexOf(g);
  form.set(`g${i}_1_content`,'Tomato');form.set(`g${i}_label`,'Other');form.set(`g${i}_day`,'4');form.set(`g${i}_1_origin`,'automation');form.set(`g${i}_1_manual_locked`,'0');
  await save(f,w,s.collectionFromForm(form,c));
  let stored=(await s.readWeek(f.env,w.id)).collection.groups.find(g=>g.id===soupGroupId(w.collection.id,3));
  assert.equal(stored.label,'Soup');assert.equal(stored.day_of_week,3);assert.equal(stored.slots[0].manual_locked,1);assert.equal(stored.slots[0].origin,'manual');
  f.sql("UPDATE special_slots SET origin='automation',manual_locked=0,last_auto_value=content WHERE group_id=? AND position=1",stored.id);
  c=withSoupControls((await s.readWeek(f.env,w.id)).collection);form=formFor(c);i=c.groups.findIndex(g=>g.id===stored.id);
  const before=f.sql('SELECT * FROM special_slots WHERE group_id=?',stored.id);form.set('g0_1_content','Unrelated edit');await save(f,w,s.collectionFromForm(form,c));
  assert.deepEqual(f.sql('SELECT * FROM special_slots WHERE group_id=?',stored.id),before);
  c=withSoupControls((await s.readWeek(f.env,w.id)).collection);form=formFor(c);form.set(`g${i}_1_content`,'');await save(f,w,s.collectionFromForm(form,c));
  stored=(await s.readWeek(f.env,w.id)).collection.groups.find(g=>g.id===stored.id);assert.equal(stored.enabled,0);assert.equal(stored.slots[0].content,'');
});
test('new-week Soup identity survives GET/POST and recurring content remains absent',async t=>{
  const f=fixture(t),defaults=await s.readCollection(f.env,'defaults');const draft=withSoupControls(s.newWeekFromDefaults(defaults));
  const form=formFor(draft),g=draft.groups.find(g=>isSoupGroup(g)&&g.day_of_week===3),i=draft.groups.indexOf(g);
  form.set(`g${i}_1_content`,'French Onion');form.set(`g${i}_hide`,'on');
  const parsed=s.collectionFromForm(form,withSoupControls(s.newWeekFromDefaults(defaults)));
  const saved=await s.saveCollection(f.env,parsed,{start:'2030-01-07',end:'2030-01-13'});
  const actual=(await s.readWeek(f.env,saved.id)).collection.groups.find(g=>g.id===soupGroupId(saved.collectionId,3));
  assert.equal(actual.slots[0].content,'French Onion');assert.equal(actual.slots[0].manual_locked,1);assert.equal(actual.enabled,0);
  assert.ok(!(await s.readCollection(f.env,'defaults')).groups.some(isSoupGroup));
});
test('stale admin Soup draft is preserved and cannot create rows',async t=>{
  const f=fixture(t);f.env.SESSIONS={get:async()=> '1'};const w=await weekFor(f),c=withSoupControls(w.collection),form=formFor(c);
  const i=c.groups.findIndex(g=>isSoupGroup(g)&&g.day_of_week===3);form.set(`g${i}_1_content`,'UnsavedSoupDraft');
  for(const [key,value]of Object.entries({action:'save-weekly-specials',weekly_id:w.id,week_start_date:w.week_start_date}))form.set(key,String(value));
  f.sql('UPDATE special_collections SET revision=revision+1 WHERE id=?',w.collection.id);const before=f.sql('SELECT * FROM special_groups ORDER BY id');
  const html=await container.renderToString(adminPage,{request:new Request('http://localhost/admin/specials?week='+w.id,{method:'POST',headers:{origin:'http://localhost',cookie:'gb_session='+'a'.repeat(32)},body:form}),locals:{runtime:{env:f.env}}});
  assert.match(html,/UnsavedSoupDraft/);assert.match(html,/changed after you opened/);assert.deepEqual(f.sql('SELECT * FROM special_groups ORDER BY id'),before);
});
test('reserved identity cannot be reassigned, reused in defaults, or populated in extra slots',()=>{
  const c=withSoupControls({id:'week',kind:'week',weekly_special_id:1,title:'',schedule:'',revision:0,groups:[]});
  s.validateCollection(c);
  for(const mutate of [c=>c.kind='defaults',c=>c.groups[0].service='nightly',c=>c.groups[0].id='soup:other:0',c=>c.groups[0].slots[1].content='Extra']){
    const bad=structuredClone(c);mutate(bad);assert.throws(()=>s.validateCollection(bad),/Soup/);
  }
});
test('privacy reflects Workers AI, public business content and actual temporary retention',async()=>{
  const html=await container.renderToString(privacyPage,{request:new Request('http://localhost/privacy')});
  assert.match(html,/October 7, 2026/);assert.match(html,/Cloudflare Workers AI/);assert.match(html,/not website visitors/);assert.match(html,/approximately 30 days/);assert.match(html,/Saved specials/);
  for(const text of ['targeted','Facebook embed','Cloudflare Web Analytics','Resend','Google Maps','gb_session'])assert.ok(html.includes(text));
});
