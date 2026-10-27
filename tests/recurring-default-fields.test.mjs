import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
const store=loadTs('src/lib/specials-store.ts');
const admin=(await import('../dist/_worker.js/pages/admin/specials.astro.mjs')).page().default;
test('preset UI, hardcoded options, markers and handlers are removed; both per-day All Day fields remain editable',async t=>{
  const f=fixture(t);f.env.SESSIONS={get:async()=> '1'};
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  const html=await (await AstroContainer.create()).renderToString(admin,{request:new Request('https://grayznbuffalo.com/admin/specials',{headers:{cookie:'gb_session='+'a'.repeat(32)}}),locals:{runtime:{env:f.env}}});
  const form=html.match(/<form[^>]*id="recurring-defaults-form"[\s\S]*?<\/form>/)[0];
  assert.doesNotMatch(form,/sandwich-preset|Daily sandwich preset|Choose a preset|data-sandwich-index/);
  const defaults=await store.readCollection(f.env,'defaults');
  for(const day of [0,1,2,3,4,5,6]){
    const index=defaults.groups.findIndex(g=>g.day_of_week===day&&g.service==='all-day');assert.ok(index>=0);
    for(const position of [1,2])assert.match(form,new RegExp(`<textarea[^>]*name="g${index}_${position}_content"`));
  }
  const source=readFileSync('src/pages/admin/specials.astro','utf8');assert.doesNotMatch(source,/sandwich-preset|data-sandwich-index|recurring-defaults__preset|preset\.value/);
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
});
test('direct description, side and price edits affect future new weeks only and preserve saved weekly ownership',async t=>{
  const f=fixture(t);const defaults=await store.readCollection(f.env,'defaults');
  const draft=store.newWeekFromDefaults(defaults);const saved=await store.saveCollection(f.env,draft,{start:'2030-01-07',end:'2030-01-13'});
  const before=await store.readWeek(f.env,saved.id);
  const allDay=defaults.groups.find(g=>g.day_of_week===2&&g.service==='all-day');
  allDay.slots[0].content='Different meal with Side Salad, Soup or Coleslaw $12.25';allDay.slots[1].content='New sandwich with Fries $8.75';
  await store.saveCollection(f.env,defaults);
  assert.deepEqual(await store.readWeek(f.env,saved.id),before);
  const future=store.newWeekFromDefaults(await store.readCollection(f.env,'defaults')).groups.find(g=>g.day_of_week===2&&g.service==='all-day');
  assert.deepEqual(future.slots.slice(0,2).map(s=>s.content),allDay.slots.slice(0,2).map(s=>s.content));
  assert.ok(future.slots.slice(0,2).every(s=>s.origin==='manual'&&s.manual_locked===0));
});
