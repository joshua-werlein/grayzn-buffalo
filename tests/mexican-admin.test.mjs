// Run the production build first: these tests exercise the compiled admin route.
import test from 'node:test';
import assert from 'node:assert/strict';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
import {ensureAutomaticWeek} from '../workers/fb-feed/auto-week.js';
const store=loadTs('src/lib/specials-store.ts');
const admin=(await import('../dist/_worker.js/pages/admin/specials.astro.mjs')).page().default;
const publicPage=(await import('../dist/_worker.js/pages/specials.astro.mjs')).page().default;
const container=await AstroContainer.create();
const cookie='gb_session='+'a'.repeat(32);
async function setup(t) {
  const f=fixture(t);f.env.SESSIONS={get:async()=> '1'};
  const defaults=await store.readCollection(f.env,'mexican-night-defaults');
  defaults.groups=['Favorites','Substitutions & Add-ons'].map((label,i)=>{
    const group=store.blankGroup(-1,i);group.label=label;
    group.slots[0].content=i?'Substitute chicken':'Taco Salad | Large · Small · Mini\nMeat and cheese';
    return group;
  });
  await store.saveCollection(f.env,defaults);
  f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  t.mock.method(Date,'now',()=>Date.parse('2030-01-14T01:00:00Z'));
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  return f;
}
function bodyFor(collection,action) {
  const body=new FormData();
  for(const [key,value] of Object.entries({action,revision:collection.revision,group_count:collection.groups.length,title:collection.title,schedule:collection.schedule})) body.set(key,String(value));
  collection.groups.forEach((g,i)=>{
    for(const [key,value] of Object.entries({id:g.id,day:g.day_of_week,service:g.service,label:g.label,time:g.service_time,enabled:'on'})) body.set(`g${i}_${key}`,String(value));
    for(const slot of g.slots) {
      const [title,...rest]=(slot.content??'').split('\n');
      body.set(`g${i}_${slot.position}_title`,title);body.set(`g${i}_${slot.position}_description`,rest.join('\n'));
    }
  });return body;
}
const post=(f,body)=>container.renderToResponse(admin,{request:new Request('http://localhost/admin/specials',{
  method:'POST',headers:{origin:'http://localhost',cookie,accept:'application/json'},body,
}),locals:{runtime:{env:f.env}}});

test('compiled admin presents distinct recurring/live forms with unique fields and clear price guidance',async t=>{
  const f=await setup(t);
  const html=await container.renderToString(admin,{request:new Request('http://localhost/admin/specials',{headers:{cookie}}),locals:{runtime:{env:f.env}}});
  const recurring=html.match(/<form[^>]*id="mexican-defaults-form"[\s\S]*?<\/form>/)[0];
  const live=html.match(/<form[^>]*id="mexican-form"[\s\S]*?<\/form>/)[0];
  assert.match(recurring,/Recurring Mexican Night Defaults/);assert.match(recurring,/future Mexican Night weeks only/);
  assert.match(recurring,/does not change the currently published/);assert.match(recurring,/no prices/);
  assert.match(recurring,/value="save-mexican-night-defaults"/);assert.match(recurring,/Item name \/ sizes/);
  assert.match(live,/This Week’s Mexican Night/);assert.match(live,/protects this week from Facebook replacement/);
  assert.match(live,/does not change recurring defaults/);assert.match(live,/value="save-mexican-night"/);
  assert.match(live,/Item \/ price/);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length,'labels and controls have unique IDs, including group templates');
});

for(const recurring of [true,false]) test(`compiled ${recurring?'recurring':'live'} POST saves only its own collection`,async t=>{
  const f=await setup(t);const id=recurring?'mexican-night-defaults':'mexican-night';
  const other=recurring?'mexican-night':'mexican-night-defaults';
  const before=await store.readCollection(f.env,other);const draft=await store.readCollection(f.env,id);
  const body=bodyFor(draft,recurring?'save-mexican-night-defaults':'save-mexican-night');
  body.set('g0_1_title',recurring?'Future taco recipe':'Staff taco recipe $12');
  const response=await post(f,body);assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
  assert.match((await store.readCollection(f.env,id)).groups[0].slots[0].content,recurring?/Future taco recipe/:/Staff taco recipe \$12/);
  assert.deepEqual(await store.readCollection(f.env,other),before);
  const source=f.sql('SELECT section_source FROM special_collections WHERE id=?',id)[0].section_source;
  assert.equal(source,recurring?null:'manual');
});

test('compiled recurring POST rejects prices, wrong-collection group IDs and stale revisions without touching live data',async t=>{
  const f=await setup(t);const defaults=await store.readCollection(f.env,'mexican-night-defaults');
  const live=await store.readCollection(f.env,'mexican-night');
  for(const [edit,status,reason] of [
    [body=>body.set('g0_1_title','Taco $12'),400,/cannot include prices/],
    [body=>body.set('g0_id',live.groups[0].id),400,/Unknown special group/],
    [body=>body.set('revision','0'),409,/changed after you opened/],
  ]) {
    const body=bodyFor(defaults,'save-mexican-night-defaults');edit(body);
    const response=await post(f,body);assert.equal(response.status,status);assert.match((await response.json()).error,reason);
    assert.deepEqual(await store.readCollection(f.env,'mexican-night'),live);
    assert.deepEqual(await store.readCollection(f.env,'mexican-night-defaults'),defaults);
  }
});

test('public page renders seeded price-free size names, descriptions and accessories',async t=>{
  const f=await setup(t);const before=await store.readCollection(f.env,'mexican-night');
  const html=await container.renderToString(publicPage,{request:new Request('http://localhost/specials'),locals:{runtime:{env:f.env,now:new Date('2030-01-15T16:00:00Z')}}});
  const menu=html.match(/<div class="mexican-night-menu"[\s\S]*?<\/article>/)[0];
  assert.match(menu,/Taco Salad \| Large · Small · Mini/);assert.match(menu,/Meat and cheese/);
  assert.match(menu,/Substitute chicken/);assert.doesNotMatch(menu,/\$/);
  assert.deepEqual(await store.readCollection(f.env,'mexican-night'),before);
});
