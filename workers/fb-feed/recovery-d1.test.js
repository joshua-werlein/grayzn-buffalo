import assert from 'node:assert/strict';
import test from 'node:test';
import {Miniflare} from 'miniflare';
import {harness} from './test-fixture.js';
import {finishImportAttempt,IMPORT_RETRY_MS} from './recovery.js';

test('real local D1: recovery claims serialize, late results are fenced, and status/audit roll back together',async t=>{
  const f=harness(t);
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  for(const table of ['weekly_specials','special_collections','special_groups','special_slots','special_migration_checks','special_imports','special_import_events']) {
    await DB.prepare(f.sql('SELECT sql FROM sqlite_master WHERE name=?',table)[0].sql).run();
    for(const row of f.sql(`SELECT * FROM ${table}`))await DB.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row)).run();
  }
  f.env.DB=DB;const run=f.env.AI.run;let fail=true;
  f.env.AI.run=async(...args)=>{if(fail){fail=false;f.state.aiCalls++;throw Error('503 temporarily unavailable');}return run(...args);};
  await f.run();const first=await DB.prepare('SELECT * FROM special_imports').first();
  assert.equal(first.processing_status,'pending');assert.equal(first.retry_count,1);
  f.state.now+=IMPORT_RETRY_MS;await Promise.all([f.run(),f.run()]);
  const saved=await DB.prepare('SELECT * FROM special_imports').first();
  assert.equal(saved.processing_status,'staged');assert.equal(saved.retry_count,2);assert.equal(f.state.aiCalls,2);
  assert.equal((await DB.prepare("SELECT count(*) n FROM special_import_events WHERE event_type='extract'").first()).n,2);
  assert.equal((await DB.prepare("SELECT count(*) n FROM special_import_events WHERE event_type='review'").first()).n,1);
  assert.equal(await finishImportAttempt(f.env,first,{status:'failed',reason:'late error',failureKind:'permanent'}),false);
  assert.deepEqual(await DB.prepare('SELECT * FROM special_imports').first(),saved);

  // Inject a transaction failure after completion statements have executed.
  await DB.prepare("UPDATE special_imports SET processing_status='processing',lease_expires_at=? WHERE id=?")
    .bind(new Date(f.state.now+60000).toISOString(),saved.id).run();
  const before=await DB.prepare('SELECT * FROM special_imports').first();
  const audit=await DB.prepare('SELECT * FROM special_import_events ORDER BY id').all();
  const failing={DB:{prepare:DB.prepare.bind(DB),batch:statements=>DB.batch([...statements,DB.prepare('INSERT INTO missing_table VALUES(1)')])}};
  await assert.rejects(()=>finishImportAttempt(failing,before,{status:'failed',reason:'test failure',failureKind:'permanent'}));
  assert.deepEqual(await DB.prepare('SELECT * FROM special_imports').first(),before);
  assert.deepEqual((await DB.prepare('SELECT * FROM special_import_events ORDER BY id').all()).results,audit.results);
});
