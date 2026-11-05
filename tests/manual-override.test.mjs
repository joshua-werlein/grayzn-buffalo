import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from '../workers/fb-feed/test-fixture.js';
import {isSoupGroup} from '../src/lib/daily-soup.js';
import {loadTs} from './load-ts.mjs';
const s=loadTs('src/lib/specials-store.ts');
const {reading:NOV4}=JSON.parse(readFileSync('tests/fixtures/nov4-daily.json','utf8'));

// The newest verified Facebook information normally wins: a staff edit is replaced
// only by a post verified as newer than the edit, and never while locked. Edits go
// through the real editor form and save path; AI responses are mocked.
const MEALS=['Wrap and a Drink','Taco Salad and a Drink','Hot Ham and a Drink','Meatloaf and a Drink','Fish Fry and a Drink'];
const DAYS=['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'];
const weekly=(meals=MEALS)=>({type:'weekly-lunch',poster_evidence:'WEEKLY LUNCH SPECIALS 11/2-11/6 11am-1:30pm',date_range:'11/2-11/6',service_time:'11am-1:30pm',
  entries:meals.map((m,i)=>({day_of_week:i+1,content:m,evidence:`${DAYS[i]} ${m}`,uncertainties:[]}))});
const STAFF='Hot Ham and a Drink $9.75';
const POST='2026-11-02T14:51:00+0000';

function setup(t,now='2026-11-02T15:20:00Z') {
  const f=harness(t,{now,caption:'',candidate:weekly()});
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-02',week_end_date='2026-11-08' WHERE id=9000");
  const readings=new Map();
  f.env.AI.run=async(_model,request)=>{
    f.state.aiCalls++;
    const text=JSON.stringify(request.messages);
    for(const [caption,reading] of readings) if(text.includes(caption)) return {response:JSON.stringify(reading)};
    throw Error('Unexpected caption');
  };
  // Scan at a given time. Processing time is deliberately later than posting time.
  f.scan=(at,posts)=>{
    f.state.now=Date.parse(at);
    f.state.posts=posts.map(({id,caption,created,updated=created,reading})=>{
      readings.set(caption,reading);
      return {id,message:caption,created_time:created,updated_time:updated,full_picture:`https://cdn.example/${id}.jpg`};
    });
    return f.run();
  };
  f.lunch=(day=3)=>f.slots(day,'lunch')[0];
  // Submits the editor exactly as the page does: every slot, lock state included.
  f.edit=async(at,{day=3,service='lunch',position=1,content,locked})=>{
    f.state.now=Date.parse(at);
    const c=await s.readCollection(f.env,'auto-week');
    const form=new FormData();form.set('revision',String(c.revision));form.set('group_count',String(c.groups.length));
    c.groups.forEach((g,i)=>{
      for(const [key,value] of Object.entries({id:g.id,day:g.day_of_week,service:g.service,label:g.label,time:g.service_time})) form.set(`g${i}_${key}`,String(value));
      if(g.enabled && !isSoupGroup(g)) form.set(`g${i}_enabled`,'on');
      g.slots.forEach(slot=>{
        form.set(`g${i}_${slot.position}_content`,slot.content??'');form.set(`g${i}_${slot.position}_link`,slot.section_link);
        form.set(`g${i}_${slot.position}_lock_shown`,'1');
        if(slot.manual_locked===1 && slot.content?.trim()) form.set(`g${i}_${slot.position}_locked`,'on');
      });
      if(g.day_of_week===day && g.service===service) {
        if(content!==undefined) form.set(`g${i}_${position}_content`,content);
        if(locked===true) form.set(`g${i}_${position}_locked`,'on');
        if(locked===false) form.delete(`g${i}_${position}_locked`);
      }
    });
    return s.saveCollection(f.env,s.collectionFromForm(form,c),{start:'2026-11-02',end:'2026-11-08'});
  };
  f.revision=()=>f.sql("SELECT revision r FROM special_collections WHERE id='auto-week'")[0].r;
  return f;
}
const original={id:'w1',caption:'weekly-original',created:POST,reading:weekly()};
const newer=(meals=MEALS.map(m=>`${m} $11.00`))=>({id:'w2',caption:'weekly-newer',created:'2026-11-02T15:30:00+0000',reading:weekly(meals)});

// ── Ownership set by the editor ──────────────────────────────────────────────

test('a staff edit is unlocked by default and records its time',async t=>{
  const f=setup(t);
  await f.edit('2026-11-02T15:20:00Z',{content:STAFF});
  const slot=f.lunch();
  assert.equal(slot.content,STAFF);assert.equal(slot.origin,'manual');assert.equal(slot.manual_locked,0);
  assert.equal(slot.manual_edited_at,'2026-11-02T15:20:00.000Z');
});
test('saving an unrelated slot changes no other slot or edit time',async t=>{
  const f=setup(t);
  await f.edit('2026-11-02T15:20:00Z',{content:STAFF});
  const before=f.lunch();
  await f.edit('2026-11-02T16:00:00Z',{day:4,content:'Other meal $5.00'});
  assert.deepEqual(f.lunch(),before);
});
test('saving with no change writes nothing',async t=>{
  const f=setup(t);
  await f.edit('2026-11-02T15:20:00Z',{content:STAFF});
  const revision=f.revision(),before=f.lunch();
  await f.edit('2026-11-02T16:00:00Z',{});
  assert.equal(f.revision(),revision);assert.deepEqual(f.lunch(),before);
});

// ── Older and newer Facebook posts ───────────────────────────────────────────

test('an older post processed later never replaces a newer staff edit, on any scan',async t=>{
  const f=setup(t);
  await f.edit('2026-11-02T15:20:00Z',{content:STAFF});
  const before=f.lunch();
  for(const at of ['2026-11-02T15:40:00Z','2026-11-02T16:10:00Z','2026-11-02T17:10:00Z']) {
    await f.scan(at,[original]);
    assert.deepEqual(f.lunch(),before,at);
  }
  assert.equal(f.lunch(2).content,MEALS[1],'other weekdays still publish');
});
test('a post verified as newer replaces an unlocked staff edit and owns the slot',async t=>{
  const f=setup(t);
  await f.edit('2026-11-02T15:20:00Z',{content:STAFF});
  await f.scan('2026-11-02T15:40:00Z',[newer()]);
  const slot=f.lunch();
  assert.equal(slot.content,'Hot Ham and a Drink $11.00');assert.equal(slot.origin,'automation');assert.equal(slot.manual_locked,0);
  assert.equal(slot.last_auto_value,slot.content);assert.equal(slot.manual_edited_at,null);
  const revision=f.revision();
  await f.scan('2026-11-02T16:10:00Z',[newer()]);
  assert.equal(f.revision(),revision,'a repeated scan writes nothing');
});
test('a post at the same second as the edit is not newer',async t=>{
  const f=setup(t);
  await f.edit('2026-11-02T15:30:00Z',{content:STAFF});
  await f.scan('2026-11-02T15:40:00Z',[newer()]);
  assert.equal(f.lunch().content,STAFF);
});
test('a newer poster without a price replaces a priced staff edit; its price is not carried over',async t=>{
  const f=setup(t);
  await f.edit('2026-11-02T15:20:00Z',{content:STAFF});
  await f.scan('2026-11-02T15:40:00Z',[newer(MEALS)]);
  assert.equal(f.lunch().content,MEALS[2]);
  assert.match(f.sql("SELECT detail FROM special_import_events WHERE detail LIKE 'GUARDED_WEEKLY_LUNCH:%' ORDER BY id DESC")[0].detail,/price removed: 3$/);
});
test('a staff edit made after a newer post is safe from that post',async t=>{
  const f=setup(t);
  await f.scan('2026-11-02T15:40:00Z',[newer()]);
  await f.edit('2026-11-02T15:50:00Z',{content:STAFF});
  const before=f.lunch();
  await f.scan('2026-11-02T16:10:00Z',[newer()]);
  assert.deepEqual(f.lunch(),before);
});

// ── A Facebook updated time is not proof of a newer poster ───────────────────

test('a later updated time on an unchanged post (a comment) does not beat a staff edit',async t=>{
  const f=setup(t);
  await f.scan('2026-11-02T15:00:00Z',[original]);
  await f.edit('2026-11-02T15:20:00Z',{content:STAFF});
  await f.scan('2026-11-02T15:40:00Z',[{...original,updated:'2026-11-02T15:35:00+0000'}]);
  assert.equal(f.lunch().content,STAFF);
  assert.equal(f.imports().length,2,'the bumped post really was read again');
});
test('a post actually edited after the staff edit counts as newer',async t=>{
  const f=setup(t);
  await f.scan('2026-11-02T15:00:00Z',[original]);
  await f.edit('2026-11-02T15:20:00Z',{content:STAFF});
  await f.scan('2026-11-02T15:40:00Z',[{...original,caption:'weekly-reworded',updated:'2026-11-02T15:35:00+0000',reading:weekly(MEALS.map(m=>`${m} $11.00`))}]);
  assert.equal(f.lunch().content,'Hot Ham and a Drink $11.00');
});

// ── Lock control ─────────────────────────────────────────────────────────────

test('an explicitly locked special survives newer posts until staff unlock it',async t=>{
  const f=setup(t);
  await f.edit('2026-11-02T15:20:00Z',{content:STAFF,locked:true});
  assert.equal(f.lunch().manual_locked,1);
  const before=f.lunch();
  await f.scan('2026-11-02T15:40:00Z',[newer()]);
  await f.scan('2026-11-02T16:10:00Z',[newer()]);
  assert.deepEqual(f.lunch(),before);
  await f.edit('2026-11-02T16:20:00Z',{locked:false});
  assert.equal(f.lunch().manual_locked,0);assert.equal(f.lunch().content,STAFF);
  assert.equal(f.lunch().manual_edited_at,before.manual_edited_at,'unlocking keeps the real edit time');
  await f.scan('2026-11-02T16:40:00Z',[newer()]);
  assert.equal(f.lunch().content,'Hot Ham and a Drink $11.00','newer than the edit, so it may replace after unlocking');
});
test('editing a locked special keeps it locked',async t=>{
  const f=setup(t);
  await f.edit('2026-11-02T15:20:00Z',{content:STAFF,locked:true});
  await f.edit('2026-11-02T15:25:00Z',{content:'Hot Ham and a Drink $9.50'});
  assert.equal(f.lunch().manual_locked,1);assert.equal(f.lunch().manual_edited_at,'2026-11-02T15:25:00.000Z');
});
test('locking only changes protection, not the value or its owner',async t=>{
  const f=setup(t);
  await f.scan('2026-11-02T15:00:00Z',[original]);
  const auto=f.lunch(),revision=f.revision();
  await f.edit('2026-11-02T15:20:00Z',{locked:true});
  assert.equal(f.revision(),revision+1,'a lock change alone is saved');
  assert.deepEqual(f.lunch(),{...auto,manual_locked:1});
  await f.scan('2026-11-02T15:40:00Z',[newer()]);
  assert.equal(f.lunch().content,auto.content);
  await f.edit('2026-11-02T15:50:00Z',{locked:false});
  assert.deepEqual(f.lunch(),auto,'unlocked automation value is automation-owned again');
});
test('a blank slot cannot be locked',async t=>{
  const f=setup(t);
  await f.edit('2026-11-02T15:20:00Z',{content:STAFF,locked:true});
  await f.edit('2026-11-02T15:25:00Z',{content:''});
  assert.equal(f.lunch().manual_locked,0);assert.equal(f.lunch().content,'');
});

// ── Existing protections, which this release does not unlock ─────────────────

const legacyLock=f=>f.sql(`UPDATE special_slots SET content=?,origin='manual',manual_locked=1,manual_edited_at=NULL WHERE position=1 AND group_id IN
  (SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=3 AND service='lunch')`,STAFF);
test('an existing lock with no recorded time stays locked against every post',async t=>{
  const f=setup(t);
  legacyLock(f);
  const before=f.lunch();
  await f.scan('2026-11-02T15:40:00Z',[original,newer()]);
  assert.deepEqual(f.lunch(),before);
});
test('unlocking an existing lock counts as edited now: only later posts may replace it',async t=>{
  const f=setup(t);
  legacyLock(f);
  await f.edit('2026-11-02T15:35:00Z',{locked:false});
  assert.equal(f.lunch().manual_edited_at,'2026-11-02T15:35:00.000Z');
  await f.scan('2026-11-02T15:40:00Z',[newer()]);
  assert.equal(f.lunch().content,STAFF,'posted 15:30, before the unlock');
});
test('a recurring default stays replaceable by any verified post',async t=>{
  const f=setup(t);
  f.sql(`UPDATE special_slots SET content='Default meal',origin='manual',manual_locked=0,last_auto_value=NULL,manual_edited_at=NULL WHERE position=1 AND group_id IN
    (SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=3 AND service='lunch')`);
  await f.scan('2026-11-02T15:40:00Z',[original]);
  assert.equal(f.lunch().content,MEALS[2]);
});

// ── Clearing a slot ──────────────────────────────────────────────────────────

test('a cleared slot stays clear against older posts and fills from a newer one',async t=>{
  const f=setup(t);
  await f.scan('2026-11-02T15:00:00Z',[original]);
  await f.edit('2026-11-02T15:20:00Z',{content:''});
  await f.scan('2026-11-02T15:25:00Z',[original]);
  assert.equal(f.lunch().content,'','older poster does not refill');
  await f.scan('2026-11-02T15:40:00Z',[newer()]);
  assert.equal(f.lunch().content,'Hot Ham and a Drink $11.00');
});

// ── Daily posters and the November 4 correction ──────────────────────────────

const NOV4_POST={id:'583672228384067_1756146729386537',caption:'',created:'2026-11-04T15:48:06+0000',reading:NOV4};
const CORRECTION='Chicken Fettuccine Alfredo With Breadsticks and A Drink $9.75',AUTO='Chicken Fettuccine Alfredo With Breadsticks and A Drink';
const nov4=t=>{
  const f=setup(t,'2026-11-04T16:05:02Z');
  // Confirmed production state of the November 4 lunch.
  f.sql(`UPDATE special_slots SET content=?,price='',origin='manual',manual_locked=1,last_auto_value=?,manual_edited_at=NULL WHERE position=1 AND group_id IN
    (SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=3 AND service='lunch')`,CORRECTION,AUTO);
  return f;
};
const conflicts=f=>f.sql("SELECT detail FROM special_import_events WHERE detail LIKE 'GUARDED_AUTO_CONFLICT%' ORDER BY id").map(e=>e.detail);
test('the November 4 $9.75 correction cannot be overwritten by the older November 4 post',async t=>{
  const f=nov4(t);
  const before=f.lunch();
  await f.scan('2026-11-04T16:30:00Z',[NOV4_POST]);
  await f.scan('2026-11-04T17:00:00Z',[NOV4_POST]);
  assert.deepEqual(f.lunch(),before);
  assert.deepEqual(f.slots(3,'all-day').slice(0,2).map(x=>x.content),NOV4.offers.slice(1).map(o=>o.content),'All Day still publishes');
});
test('the November 4 correction is still safe from that post after an unlock',async t=>{
  const f=nov4(t);
  await f.edit('2026-11-04T16:20:00Z',{locked:false});
  await f.scan('2026-11-04T16:30:00Z',[NOV4_POST]);
  assert.equal(f.lunch().content,CORRECTION);
  assert.match(conflicts(f).at(-1),/Newer staff edit retained/);
  const before=f.lunch(),count=conflicts(f).length;
  await f.scan('2026-11-04T17:00:00Z',[NOV4_POST]);
  assert.deepEqual(f.lunch(),before);assert.equal(conflicts(f).length,count,'a repeated scan records nothing new');
});
test('a daily post newer than an unlocked staff edit replaces it, and valid offers publish beside a hold',async t=>{
  const f=setup(t,'2026-11-04T15:00:00Z');
  await f.edit('2026-11-04T15:00:00Z',{content:'Staff lunch $9.00'});
  await f.edit('2026-11-04T15:00:00Z',{service:'all-day',position:1,content:'Staff all day $8.00'});
  await f.scan('2026-11-04T15:50:00Z',[NOV4_POST]);
  assert.equal(f.lunch().content,NOV4.offers[0].content);
  assert.equal(f.slots(3,'all-day')[0].content,NOV4.offers[1].content);
});
test('an older daily post leaves a newer staff edit but fills other slots',async t=>{
  const f=setup(t,'2026-11-04T16:00:00Z');
  await f.edit('2026-11-04T16:00:00Z',{content:'Staff lunch $9.00'});
  await f.scan('2026-11-04T16:30:00Z',[NOV4_POST]);
  assert.equal(f.lunch().content,'Staff lunch $9.00');
  assert.deepEqual(f.slots(3,'all-day').slice(0,2).map(x=>x.content),NOV4.offers.slice(1).map(o=>o.content));
});
