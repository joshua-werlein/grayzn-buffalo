import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
import {harness} from '../workers/fb-feed/test-fixture.js';
import {ensureAutomaticWeek} from '../workers/fb-feed/auto-week.js';
const store=loadTs('src/lib/specials-store.ts');
const rows=JSON.parse(readFileSync('tests/fixtures/mexican-recurring-prices.json','utf8'));
const sunday={today:'2030-01-13',weekday:0,hour:19};
const snapshot=(f,id)=>({
  collection:f.sql('SELECT * FROM special_collections WHERE id=?',id),
  groups:f.sql('SELECT * FROM special_groups WHERE collection_id=? ORDER BY sort,id',id),
  slots:f.sql('SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id=? ORDER BY g.sort,s.position',id),
});
async function template(f) {
  const draft=await store.readCollection(f.env,'mexican-night-defaults');
  draft.groups=['Favorites','More Mexican Night','Substitutions & Add-ons'].map((label,i)=>{
    const g=store.blankGroup(-1,i);g.label=label;g.service_time=i<2?'5–10 PM':'';
    const items=i===0?rows.slice(0,4):i===1?rows.slice(4,7):rows.slice(7);
    g.slots.forEach((s,j)=>s.content=items[j]?.[1]??'');return g;
  });
  await store.saveCollection(f.env,draft);
  return store.readCollection(f.env,'mexican-night-defaults');
}
const formFor=draft=>{
  const form=new FormData();
  for(const [key,value] of Object.entries({revision:draft.revision,group_count:draft.groups.length,title:draft.title,schedule:draft.schedule})) form.set(key,String(value));
  draft.groups.forEach((g,i)=>{
    for(const [key,value] of Object.entries({id:g.id,day:g.day_of_week,service:g.service,label:g.label,time:g.service_time,enabled:'on'})) form.set(`g${i}_${key}`,String(value));
    for(const s of g.slots) {
      const [title,...description]=(s.content??'').split('\n');
      form.set(`g${i}_${s.position}_title`,title);form.set(`g${i}_${s.position}_description`,description.join('\n'));
    }
  });return form;
};

test('recurring split-field save changes only the template; live save changes only the current menu',async t=>{
  const f=fixture(t);const defaults=await template(f);const liveBefore=snapshot(f,'mexican-night');
  const form=formFor(defaults);form.set('g0_1_description','Future recipe');
  await store.saveCollection(f.env,store.collectionFromForm(form,defaults));
  assert.deepEqual(snapshot(f,'mexican-night'),liveBefore);
  assert.equal(snapshot(f,'mexican-night-defaults').collection[0].section_source,null);
  const templateBefore=snapshot(f,'mexican-night-defaults');
  const live=await store.readCollection(f.env,'mexican-night');
  const g=store.blankGroup(-1);g.label='Staff menu';g.slots[0].content='Staff burrito $15\nCurrent correction';live.groups=[g];
  await store.saveCollection(f.env,live);
  assert.deepEqual(snapshot(f,'mexican-night-defaults'),templateBefore);
  assert.equal(snapshot(f,'mexican-night').collection[0].section_source,'manual');
  assert.equal(snapshot(f,'mexican-night').slots[0].manual_locked,1);
});

test('recurring price validation rejects inline, description, split and metadata prices without writes',async t=>{
  const f=fixture(t);await template(f);const before=snapshot(f,'mexican-night-defaults');
  for(const edit of [
    d=>d.groups[0].slots[0].content='Burrito $10',
    d=>d.groups[0].slots[0].content='Chips\nAdd salsa +$1.50',
    d=>d.groups[0].slots[0].content='Taco Salad | Large 9.00 · Small 8.50 · Mini 6.00',
    d=>d.groups[0].slots[0].content='Add cheese 50 cents',
    d=>d.groups[0].slots[0].price='10',
    d=>d.groups[0].label='Entrees $10',
    d=>d.schedule='Tuesday $10',
  ]) {
    const draft=await store.readCollection(f.env,'mexican-night-defaults');edit(draft);
    await assert.rejects(()=>store.saveCollection(f.env,draft),/cannot include prices/);
    assert.deepEqual(snapshot(f,'mexican-night-defaults'),before);
  }
});

test('template price cleanup matches inspected values, preserves live locks and is idempotent',async t=>{
  const f=fixture(t);const defaults=await template(f);
  const live=await store.readCollection(f.env,'mexican-night');
  live.groups=defaults.groups.map(g=>({...g,id:store.blankGroup(-1).id,slots:g.slots.map(s=>({...s}))}));
  await store.saveCollection(f.env,live);
  const populated=defaults.groups.flatMap(g=>g.slots.filter(s=>s.content).map(s=>({g,s})));
  populated.forEach(({g,s},i)=>f.sql('UPDATE special_slots SET content=? WHERE group_id=? AND position=?',rows[i][0],g.id,s.position));
  f.sql("UPDATE special_collections SET section_source='manual',revision=6,section_week_start='2030-01-14' WHERE id='mexican-night'");
  const liveBefore=snapshot(f,'mexican-night');const before=snapshot(f,'mexican-night-defaults');
  assert.ok(liveBefore.slots.filter(s=>s.content).every(s=>s.manual_locked===1));
  const migration=readFileSync('migrations/0020_mexican_night_price_free_defaults.sql','utf8');
  const apply=()=>f.execute({statements:migration.split(/;\s*\n/).map(sql=>sql.trim()).filter(Boolean).map(sql=>({sql,args:[]}))});
  apply();const after=snapshot(f,'mexican-night-defaults');
  assert.deepEqual(after.slots.filter(s=>s.content).map(s=>s.content),rows.map(r=>r[1]));
  assert.ok(after.slots.every(s=>s.price===''&&!s.content.includes('$')));
  assert.deepEqual(after.groups,before.groups);
  assert.equal(after.collection[0].revision,before.collection[0].revision+1);
  assert.deepEqual(snapshot(f,'mexican-night'),liveBefore);
  await assert.rejects(()=>store.saveCollection(f.env,defaults),store.SpecialConflict);
  apply();assert.deepEqual(snapshot(f,'mexican-night-defaults'),after);
  // Unknown text must never be silently rewritten by a broad price stripper.
  f.sql('UPDATE special_slots SET content=? WHERE group_id=? AND position=1','Edited recipe $99',defaults.groups[0].id);
  apply();assert.equal(snapshot(f,'mexican-night-defaults').slots[0].content,'Edited recipe $99');
});

for(const explicitAccessories of [false,true]) test(`price-free seed accepts Tuesday Facebook prices; accessories ${explicitAccessories?'replaced':'preserved'}`,async t=>{
  const candidate={type:'mexican-night',poster_evidence:'Mexican Night',schedule:'Tuesday 5–10 PM',groups:[
    {label:'Favorites',items:[{title:'Burrito $11.75',description:'Fresh beans'},{title:'Taco Salad Large $12 · Small $10 · Mini $8',description:'Meat and cheese'}]},
    ...(explicitAccessories?[{label:'Substitutions & Add-ons',items:[{title:'Substitute chicken +$2',description:''},{title:'Substitute queso +$1',description:''}]}]:[]),
  ]};
  const f=harness(t,{now:'2030-01-14T01:00:00Z',week:false,candidate,caption:'Mexican Night'});
  await template(f);const defaultsBefore=snapshot(f,'mexican-night-defaults');
  await ensureAutomaticWeek(f.env,sunday);
  const seeded=snapshot(f,'mexican-night');
  assert.equal(seeded.collection[0].section_source,'recurring');
  assert.deepEqual(seeded.slots.map(s=>s.content),defaultsBefore.slots.map(s=>s.content));
  assert.ok(seeded.slots.every(s=>s.price===''&&!s.content.includes('$')&&s.manual_locked===0));
  const accessories=seeded.slots.filter(s=>s.group_id===seeded.groups[2].id);
  f.state.now=Date.parse('2030-01-15T16:00:00Z');
  f.state.posts[0].created_time=f.state.posts[0].updated_time='2030-01-15T15:00:00Z';
  await f.run();const live=snapshot(f,'mexican-night');
  assert.equal(live.collection[0].section_source,'facebook');
  assert.ok(live.slots.some(s=>s.content==='Burrito $11.75\nFresh beans'));
  assert.ok(live.slots.some(s=>s.content.includes('Large $12 · Small $10 · Mini $8')));
  if(explicitAccessories) {
    assert.ok(live.slots.some(s=>s.content==='Substitute chicken +$2'));
    assert.ok(live.slots.some(s=>s.content==='Substitute queso +$1'));
  } else assert.deepEqual(live.slots.filter(s=>s.group_id===seeded.groups[2].id),accessories);
  assert.deepEqual(snapshot(f,'mexican-night-defaults'),defaultsBefore);
  f.state.now=Date.parse('2030-01-21T01:00:00Z');
  await ensureAutomaticWeek(f.env,{today:'2030-01-20',weekday:0,hour:19});
  assert.deepEqual(snapshot(f,'mexican-night').slots.map(s=>s.content),defaultsBefore.slots.map(s=>s.content));
  assert.ok(snapshot(f,'mexican-night').slots.every(s=>s.price===''&&!s.content.includes('$')));
});

test('manual price-free live correction blocks Tuesday Facebook but next week uses the template',async t=>{
  const f=harness(t,{now:'2030-01-14T01:00:00Z',week:false,caption:'Mexican Night',candidate:{type:'mexican-night',poster_evidence:'Mexican Night',groups:[{label:'Entrees',items:[{title:'Poster burrito $12',description:''}]}]}});
  await template(f);await ensureAutomaticWeek(f.env,sunday);
  const draft=await store.readCollection(f.env,'mexican-night');draft.groups[0].slots[0].content='This week only\nStaff recipe';
  await store.saveCollection(f.env,draft);const protectedMenu=snapshot(f,'mexican-night');
  f.state.now=Date.parse('2030-01-15T16:00:00Z');f.state.posts[0].created_time=f.state.posts[0].updated_time='2030-01-15T15:00:00Z';
  await f.run();assert.deepEqual(snapshot(f,'mexican-night'),protectedMenu);
  f.state.now=Date.parse('2030-01-21T01:00:00Z');await ensureAutomaticWeek(f.env,{today:'2030-01-20',weekday:0,hour:19});
  assert.deepEqual(snapshot(f,'mexican-night').slots.map(s=>s.content),snapshot(f,'mexican-night-defaults').slots.map(s=>s.content));
});
