import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
const {approvalModel,approveImport}=loadTs('src/lib/automation-approval.ts');
const source=JSON.parse(readFileSync('tests/fixtures/oct27-production.json','utf8'));
test('real local D1: concurrent staff approvals commit values and a single receipt atomically',async t=>{
  const f=fixture(t),mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local test")}}',d1Databases:['DB']});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  const names=['weekly_specials','special_collections','special_groups','special_slots','special_migration_checks','special_imports','special_import_events'];
  for(const table of names){
    const schema=f.sql("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",table)[0].sql;
    await DB.prepare(schema).run();
    const rows=f.sql(`SELECT * FROM ${table}`);if(!rows.length)continue;
    const columns=Object.keys(rows[0]);
    await DB.prepare(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map(k=>`json_extract(value,'$.${k}')`).join(',')} FROM json_each(?1)`).bind(JSON.stringify(rows)).run();
  }
  await DB.batch([
    DB.prepare("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(9000,'2026-10-26','2026-11-01')"),
    DB.prepare("INSERT INTO special_collections(id,kind,weekly_special_id) VALUES('week','week',9000)"),
    DB.prepare("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,enabled) VALUES('lunch','week',2,'lunch','Lunch',1)"),
    DB.prepare("INSERT INTO special_slots(group_id,position,content,origin,manual_locked) SELECT 'lunch',value,'','legacy',0 FROM json_each('[1,2,3,4]')"),
    DB.prepare("INSERT INTO special_imports(id,fb_post_id,fb_created_time,image_r2_key,extracted_json,processing_status,validation_result) VALUES('test','post','2026-10-27T15:00:00Z','test.jpg',?1,'staged','ok')").bind(JSON.stringify(source.daily)),
  ]);
  const now=new Date('2026-10-27T21:00:00Z'),env={DB};
  const m=await approvalModel(env,'test','2026-10-27',now);
  const input={importId:'test',day:m.day,revision:m.collection.revision,evidenceHash:m.evidenceHash,requestId:m.requestId,confirmed:true,
    rows:[{key:'d:0',content:m.entries[0].content,destination:m.destinations[0].id}]};
  const before=(await DB.prepare("SELECT * FROM special_slots WHERE group_id='lunch' ORDER BY position").all()).results;
  const outcomes=await Promise.allSettled([approveImport(env,input,now),approveImport(env,{...input,requestId:crypto.randomUUID()},now)]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  const after=(await DB.prepare("SELECT * FROM special_slots WHERE group_id='lunch' ORDER BY position").all()).results;
  assert.equal(after[0].content,'Gyro Sandwich with Beer Fries & a Drink $9.75');assert.equal(after[0].manual_locked,1);
  assert.deepEqual(after.slice(1),before.slice(1));
  assert.equal((await DB.prepare("SELECT count(*) n FROM special_import_events WHERE detail LIKE 'STAFF_APPROVAL:%'").first()).n,1);
});
