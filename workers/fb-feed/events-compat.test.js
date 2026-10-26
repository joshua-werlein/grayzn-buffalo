import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {reconcileEvents} from './event-store.js';

test('local D1 with unchanged 0025: concurrent event inserts and retained tombstones remain compatible',async t=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local test")}}',d1Databases:['DB']});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  const migration=readFileSync(new URL('../../migrations/0025_special_events.sql',import.meta.url),'utf8').replace(/^--.*$/gm,'');
  for(const sql of migration.split(';').map(s=>s.trim()).filter(Boolean)) await DB.prepare(sql).run();
  await DB.prepare(`CREATE TABLE special_imports(id TEXT PRIMARY KEY,fb_post_id TEXT,fb_created_time TEXT,
    processing_status TEXT,validation_result TEXT,candidate_json TEXT,extracted_json TEXT,image_r2_key TEXT,
    review_status TEXT,parser_version INTEGER,caption TEXT,permalink_url TEXT)`).run();
  const {brewers_event:candidate}=JSON.parse(readFileSync(new URL('../../tests/fixtures/oct23-friday-night.json',import.meta.url),'utf8'));
  const seed=async id=>DB.prepare(`INSERT INTO special_imports VALUES(?1,?1,'2026-10-23T20:00:00Z',
    'staged','ok',?2,NULL,'synthetic-image','pending',19,'','')`).bind(id,JSON.stringify(candidate)).run();
  const env={DB,SPECIAL_EVENTS_MODE:'AUTO',SPECIALS_EVIDENCE_VERSION:'2'};
  await seed('original');await seed('reminder');
  await Promise.all(['original','reminder'].map(id=>reconcileEvents(env,{sourceIds:[id],today:'2026-10-23'})));
  assert.equal((await DB.prepare('SELECT count(*) n FROM special_events').first()).n,1);
  const before=await DB.prepare('SELECT * FROM special_events').first();
  assert.equal(before.status,'published');
  await DB.prepare(`UPDATE special_events SET status='rejected',manual_locked=1,revision=revision+1,
    event_date='2026-10-24',evidence_json='{"source_deleted_at":1}' WHERE id=?1`).bind(before.id).run();
  // Import retention/Graph absence must not delete the staff decision.
  await DB.prepare('DELETE FROM special_imports').run();
  await seed('replacement');
  const tombstone=await DB.prepare('SELECT * FROM special_events').first();
  await reconcileEvents(env,{sourceIds:['replacement'],today:'2026-10-23'});
  assert.deepEqual((await DB.prepare('SELECT * FROM special_events').all()).results,[tombstone]);
  assert.equal((await DB.prepare('SELECT count(*) n FROM special_event_offers WHERE event_id=?1').bind(before.id).first()).n,1);
  // The retired manual creation workflow did not set identity/fingerprint.
  // Without enough identity to distinguish a repost, preserve a removal by
  // conservatively blocking new event cards on that tombstone's known date.
  await DB.prepare(`UPDATE special_events SET identity=NULL,fingerprint=NULL,last_auto_json=NULL,
    event_date='2026-10-23' WHERE id=?1`).bind(before.id).run();
  await seed('legacy-replacement');
  const legacy=await DB.prepare('SELECT * FROM special_events').first();
  await reconcileEvents(env,{sourceIds:['legacy-replacement'],today:'2026-10-23'});
  assert.deepEqual((await DB.prepare('SELECT * FROM special_events').all()).results,[legacy]);
  assert.deepEqual((await DB.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
