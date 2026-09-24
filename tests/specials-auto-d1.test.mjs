import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {fixture} from './specials-fixture.mjs';
import {reconcileToday} from '../workers/fb-feed/guarded-auto.js';
import {PARSER_VERSION} from '../workers/fb-feed/classify.js';

test('real local D1 guarded publication and audit are atomic; stale snapshots fail closed',async t=>{
  const f=fixture(t);
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  for(const table of ['weekly_specials','special_collections','special_groups','special_slots','special_migration_checks','special_imports','special_import_events']) {
    await DB.prepare(f.sql('SELECT sql FROM sqlite_master WHERE name=?',table)[0].sql).run();
  }
  await DB.batch([
    DB.prepare("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(1,'2030-01-07','2030-01-13')"),
    DB.prepare("INSERT INTO special_collections(id,kind,weekly_special_id) VALUES('w','week',1)"),
    DB.prepare("INSERT INTO special_groups(id,collection_id,day_of_week,service,label) VALUES('g','w',3,'all-day','All Day')"),
    DB.prepare("INSERT INTO special_slots(group_id,position,content,origin,manual_locked) VALUES('g',1,'','automation',0),('g',2,'','automation',0)"),
    DB.prepare('INSERT INTO special_migration_checks VALUES(15,0)'),
  ]);
  const candidateJson=JSON.stringify({day_of_week:3,day_evidence:'Wednesday',poster_evidence:'All Day',offers:[{content:'One $1',service_time:'',evidence:'All Day'},{content:'Two $2',service_time:'',evidence:'All Day'}]});
  await DB.prepare(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,candidate_json,validation_result,image_r2_key,processing_status,parser_version)
    VALUES('i','p','2030-01-09',?,'ok','special-imports/test.jpg','staged',?)`).bind(candidateJson,PARSER_VERSION).run();
  const input={sourceIds:['i'],today:'2030-01-09',weekday:3};
  const failing={DB:{prepare:DB.prepare.bind(DB),batch:statements=>DB.batch([...statements,DB.prepare('INSERT INTO missing_table VALUES(1)')])}};
  await assert.rejects(()=>reconcileToday(failing,input));
  assert.equal((await DB.prepare("SELECT revision FROM special_collections WHERE id='w'").first()).revision,0);
  assert.ok((await DB.prepare('SELECT content FROM special_slots').all()).results.every(s=>s.content===''));
  assert.equal((await DB.prepare('SELECT count(*) n FROM special_import_events').first()).n,0);
  assert.equal((await reconcileToday({DB},input)).written,true);
  const slots=(await DB.prepare('SELECT * FROM special_slots ORDER BY position').all()).results;
  assert.deepEqual(slots.map(s=>[s.content,s.last_auto_value,s.origin,s.manual_locked]),[['One $1','One $1','automation',0],['Two $2','Two $2','automation',0]]);
  assert.equal((await DB.prepare("SELECT review_status FROM special_imports WHERE id='i'").first()).review_status,'pending');
  await DB.prepare("UPDATE special_imports SET review_status='pending' WHERE id='i'").run();
  const changed=candidateJson.replace('One $1','New $3');
  await DB.prepare("UPDATE special_imports SET candidate_json=? WHERE id='i'").bind(changed).run();
  const racing={DB:{prepare:DB.prepare.bind(DB),batch:async statements=>{
    await DB.prepare("UPDATE special_slots SET content='Staff',origin='manual',manual_locked=1 WHERE group_id='g' AND position=2").run();
    return DB.batch(statements);
  }}};
  assert.equal((await reconcileToday(racing,{...input,candidateJson:changed})).written,false);
  assert.equal((await DB.prepare("SELECT content FROM special_slots WHERE group_id='g' AND position=1").first()).content,'One $1');
});
