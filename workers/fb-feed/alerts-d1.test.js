import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {recordAlertObservation,dispatchAlert,ALERT_GRACE_MS} from './alert-store.js';

test('real local D1: atomic duplicate claims, recovery fencing and uncertain-send quarantine',async t=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  const sql=readFileSync(new URL('../../migrations/0023_facebook_alert_incidents.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean)) await DB.prepare(statement).run();
  let now=Date.parse('2026-10-22T15:00:00Z'),calls=0;
  const observation={day:'2026-10-22',scope:'daily',code:'publication_blocked',state:'attention',observedAt:now};
  await Promise.all([recordAlertObservation(DB,observation),recordAlertObservation(DB,observation)]);
  now+=ALERT_GRACE_MS;
  await Promise.all(Array.from({length:4},()=>dispatchAlert(DB,async()=>{calls++;throw Error('mock failure');},{enabled:true,now:()=>now})));
  assert.equal(calls,1);
  now+=5*60*1000;
  await Promise.all(Array.from({length:4},()=>dispatchAlert(DB,async()=>calls++,{enabled:true,now:()=>now})));
  assert.equal(calls,1);
  await recordAlertObservation(DB,{...observation,state:'resolved',observedAt:now+1});
  await recordAlertObservation(DB,observation);
  const row=await DB.prepare('SELECT * FROM facebook_alert_incidents').first();
  assert.equal(row.state,'resolved');assert.equal(row.attempts,1);assert.equal(row.sent_ms,null);assert.equal(row.dispatch_state,'uncertain');
});
