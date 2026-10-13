import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {harness} from './test-fixture.js';
import {expireDelivery,reconcileDelivery} from './delivery.js';

test('local D1: delivery snapshot upsert, retry, cancellation and expiry',async t=>{
  const f=harness(t);
  f.state.candidate.delivery={status:'available',evidence:'DELIVERY AVAILABLE WITHIN CITY LIMITS 11-1:30',date_evidence:'Wednesday',uncertainties:[]};
  await f.run(); // Obtain the same durable evidence the pipeline consumes.
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  await DB.prepare(f.sql("SELECT sql FROM sqlite_master WHERE name='special_imports'")[0].sql).run();
  await DB.prepare(readFileSync(new URL('../../migrations/0022_delivery_automation.sql',import.meta.url),'utf8')).run();
  for(const row of f.imports()) await DB.prepare(`INSERT INTO special_imports (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row)).run();
  const env={DB},args={sourceIds:f.imports().map(i=>i.id),observedAt:new Date(f.state.now).toISOString()};
  const state=()=>DB.prepare('SELECT * FROM delivery_automation').first();
  await reconcileDelivery(env,args);assert.equal((await state()).active,1);
  const before=await state();await reconcileDelivery(env,args);assert.deepEqual(await state(),before);
  f.state.now+=60000;
  await DB.prepare("UPDATE special_imports SET review_status='dismissed'").run();
  await reconcileDelivery(env,{...args,observedAt:new Date(f.state.now).toISOString()});assert.equal((await state()).active,0);
  await DB.prepare('UPDATE delivery_automation SET active=1').run();
  await expireDelivery(env,new Date('2030-01-09T21:00:00Z'));assert.equal((await state()).active,0);
  await reconcileDelivery(env,args);assert.equal((await state()).active,0);
});
