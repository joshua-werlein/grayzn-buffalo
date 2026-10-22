import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from '../workers/fb-feed/test-fixture.js';
import {correctOctober20MexicanNight} from '../recovery/oct20-mexican-correction.js';
for(const blocked of [false,true]) test(`prepared correction is atomic, guarded and idempotent (staff edit=${blocked})`,async t=>{
  const f=harness(t,{caption:'Mexican Night',candidate:{type:'mexican-night',poster_evidence:'Mexican Night',schedule:'Tuesday 5-10 PM',groups:[{label:'Entrees',items:[{title:'Burrito $10',description:''}]}]}});
  await f.run();
  f.sql("INSERT INTO special_imports(id,fb_post_id,fb_created_time) VALUES('bd5bead40405e72a00840a216584e429','oct20','2026-10-20T14:00:00Z')");
  f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,sort) VALUES('mn:bd5bead4:1','mexican-night',-1,'custom','Entrees',1)");
  const old='Taco Salad ... $9.00 | $8.50 | $6.00\nMeat, shredded cheese, lettuce, onion, tomato, and black olives served in a shell bowl';
  f.sql("INSERT INTO special_slots(group_id,position,content,price,origin,manual_locked,last_auto_value) VALUES('mn:bd5bead4:1',2,?,'','automation',?,?)",old,blocked?1:0,old);
  f.sql("UPDATE special_collections SET revision=11,section_week_start='2026-10-19',section_source='facebook',title=?,schedule='Every Tuesday Night 5-10pm' WHERE id='mexican-night'","TONIGHT @ GRAYZ'N BUFFALO 5-10PM! Mexican Night Every Tuesday Night 5-10pm");
  const before=f.sql("SELECT * FROM special_collections WHERE id='mexican-night'")[0];
  if(!blocked) {
    f.sql("CREATE TRIGGER reject_correction BEFORE UPDATE ON special_slots WHEN NEW.group_id='mn:bd5bead4:1' BEGIN SELECT RAISE(ABORT,'simulated correction failure'); END");
    await assert.rejects(()=>correctOctober20MexicanNight(f.env.DB),/simulated correction failure/);
    assert.deepEqual(f.sql("SELECT * FROM special_collections WHERE id='mexican-night'")[0],before);
    f.sql('DROP TRIGGER reject_correction');
  }
  const result=await correctOctober20MexicanNight(f.env.DB);
  assert.equal(result.length,blocked?0:1);
  const after=f.sql("SELECT * FROM special_collections WHERE id='mexican-night'")[0];
  if(blocked) assert.deepEqual(after,before);
  else {assert.equal(after.title,'Mexican Night');assert.equal(after.updated_at,before.updated_at);assert.equal(after.section_source,'manual');assert.match(f.sql("SELECT content FROM special_slots WHERE group_id='mn:bd5bead4:1' AND position=2")[0].content,/Large \$9.00 \| Small \$8.50 \| Mini \$6.00/);}
  assert.deepEqual(await correctOctober20MexicanNight(f.env.DB),[]);
  assert.deepEqual(f.sql("SELECT * FROM special_collections WHERE id='mexican-night'")[0],after);
});
