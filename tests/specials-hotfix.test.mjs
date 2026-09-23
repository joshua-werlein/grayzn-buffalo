import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { fixture } from './specials-fixture.mjs';
import { loadTs } from './load-ts.mjs';
const s = loadTs('src/lib/specials-store.ts');

test('local D1 reproduces old compound limit and saves all seven days atomically with JSON rowsets', async t => {
  const f = fixture(t);
  const mf = new Miniflare({ modules:true, script:'export default {fetch(){return new Response("local test")}}', d1Databases:['DB'] });
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  for (const table of ['weekly_specials','special_collections','special_groups','special_slots','special_migration_checks']) {
    await DB.prepare(f.sql('SELECT sql FROM sqlite_master WHERE name=?',table)[0].sql).run();
    const rows = f.sql(`SELECT * FROM ${table}`);
    for (let i=0;i<rows.length;i+=50) await DB.batch(rows.slice(i,i+50).map(row => DB.prepare(`INSERT INTO ${table} (${Object.keys(row)}) VALUES (${Object.keys(row).map(()=>'?')})`).bind(...Object.values(row))));
  }
  await assert.rejects(() => DB.prepare(Array.from({length:10},()=> 'SELECT 1').join(' UNION ALL ')).all(), /too many terms in compound SELECT/);
  const env = {DB};
  const week = s.newWeekFromDefaults(await s.readCollection(env,'defaults'));
  for (const g of week.groups) for (const slot of g.slots) slot.content = `${g.day_of_week} ${g.service} ${slot.position} $7.25`;
  const saved = await s.saveCollection(env,week,{start:'2030-01-07',end:'2030-01-13'});
  const loaded = await s.readWeek(env,saved.id);
  assert.equal(loaded.collection.groups.length,21);
  assert.equal(loaded.collection.groups.flatMap(g=>g.slots).length,84);
  assert.deepEqual(loaded.collection.groups.flatMap(g=>g.slots.map(x=>x.content)).sort(),week.groups.flatMap(g=>g.slots.map(x=>x.content)).sort());
  const before = await DB.prepare('SELECT * FROM special_slots ORDER BY group_id,position').all();
  const revision = loaded.collection.revision;
  for (const g of loaded.collection.groups) for (const slot of g.slots) slot.content = '';
  const failing = {DB:{prepare:DB.prepare.bind(DB),batch:statements=>DB.batch([...statements,DB.prepare('INSERT INTO missing_table VALUES(1)')])}};
  await assert.rejects(()=>s.saveCollection(failing,loaded.collection,{start:loaded.week_start_date,end:loaded.week_end_date}));
  assert.deepEqual((await DB.prepare('SELECT * FROM special_slots ORDER BY group_id,position').all()).results,before.results);
  assert.equal((await s.readWeek(env,saved.id)).collection.revision,revision);
});

test('saved week: clear Wednesday and Thursday plus multiple blanks, save, reload without defaults or unrelated changes',async t=>{
  const f=fixture(t);
  const row=f.sql('SELECT id FROM weekly_specials LIMIT 1')[0];
  let week=await s.readWeek(f.env,row.id);
  for(const g of week.collection.groups.filter(g=>[3,4].includes(g.day_of_week))) {
    f.sql("UPDATE special_slots SET content='Existing special $10' WHERE group_id=? AND position=1",g.id);
  }
  week=await s.readWeek(f.env,row.id);
  const body=new FormData();body.set('group_count',String(week.collection.groups.length));body.set('revision',String(week.collection.revision));
  week.collection.groups.forEach((g,i)=>{
    for(const [key,value] of Object.entries({id:g.id,day:g.day_of_week,service:g.service,label:g.label,time:g.service_time})) body.set(`g${i}_${key}`,String(value));
    if(g.enabled) body.set(`g${i}_enabled`,'on');
    for(const slot of g.slots) if(slot.position<=s.specialInputCount(g)) body.set(`g${i}_${slot.position}_content`,[3,4].includes(g.day_of_week)?'':s.displayedSpecial(slot));
  });
  const next=s.collectionFromForm(body,week.collection);
  await s.saveCollection(f.env,next,{start:week.week_start_date,end:week.week_end_date});
  const defaults=await s.readCollection(f.env,'defaults');
  for(const g of defaults.groups) g.slots[0].content='Changed default $20';
  await s.saveCollection(f.env,defaults);
  const reloaded=await s.readWeek(f.env,row.id);
  for(const g of reloaded.collection.groups) {
    if([3,4].includes(g.day_of_week)) for(const slot of g.slots.filter(x=>x.position<=s.specialInputCount(g))) assert.equal(slot.content,'');
    else assert.deepEqual(g,week.collection.groups.find(old=>old.id===g.id));
  }
});

test('legacy split prices normalize at candidate boundary and repeated All Day offers stay in All Day',()=>{
  for(const day of [1,5]) {
    const groups=s.normalizeCandidateGroups([
      {label:'Lunch',day_of_week:day,service:'lunch',items:[{content:'Lunch $9.75'},{content:'Sandwich',price:'$7.25'}]},
      {label:'All Day',day_of_week:day,service:'all-day',items:[{content:'Sandwich',price:'$7.25'},{content:'Burger $10.25'}]},
      {label:'Nightly',day_of_week:day,service:'nightly',items:[{content:'Dinner $14'},{content:'Ribs $18.75'},{content:'Sandwich $7.25'},{content:'Burger $10.25'}]},
    ]);
    assert.deepEqual(groups.map(g=>g.items.length),[1,2,2]);
    assert.deepEqual(groups[1].items[0],{content:'Sandwich $7.25'});
    const raw=groups.map(g=>({...s.blankGroup(day),...g,slots:g.items.map((item,i)=>({...s.blankGroup(day).slots[i],content:item.content}))}));
    raw[0].slots.push({...s.blankGroup(day).slots[1],content:'Sandwich',price:'$7.25'});
    const snapshot=structuredClone(raw);
    assert.deepEqual(s.visibleGroups(raw,day).map(g=>g.slots.length),[1,2,2]);
    assert.deepEqual(raw,snapshot,'public filtering must not mutate stored data');
  }
  assert.throws(()=>s.normalizeCandidateGroups([{label:'Lunch',day_of_week:1,service:'lunch',items:[{content:'a'.repeat(148),price:'$10'}]}]),/150/);
});
