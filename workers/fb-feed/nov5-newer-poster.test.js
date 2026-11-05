import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './test-fixture.js';
import {reconcilePosterEvidence} from './reconcile.js';

// A newer verified poster supersedes an older conflicting poster, even while the
// older post still exists. Trust comes from posting times and real content changes,
// never a comment-driven updated time. AI responses are mocked.
const offer=(content,uncertainties=[])=>({content,evidence:content.toUpperCase(),service_time:'',service_evidence:'',date_evidence:'',uncertainties});
const none={status:'none',evidence:'',date_evidence:'',uncertainties:[]};
const LUNCH='Chicken Alfredo with Breadsticks and a Drink $9.75',FIXED='Patty Melt with Fries and a Drink $9.25';
const JAL='Jalapeno Burger with Side Salad $10.25',HAM='Grilled Ham and Cheese with Chili $7.25';
const daily=(first=offer(LUNCH),rest=[offer(JAL),offer(HAM)])=>({day_of_week:3,day_evidence:'WEDNESDAY',poster_evidence:'WEDNESDAY LUNCH SPECIALS',delivery:none,offers:[first,...rest]});
const DAYS=['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'];
const MEALS=['Wrap and a Drink','Taco Salad and a Drink','Hot Ham and a Drink','Meatloaf and a Drink','Fish Fry and a Drink'];
const weekly=(meals=MEALS)=>({type:'weekly-lunch',poster_evidence:'WEEKLY LUNCH SPECIALS 11/2-11/6 11am-1:30pm',date_range:'11/2-11/6',service_time:'11am-1:30pm',
  entries:meals.map((m,i)=>({day_of_week:i+1,content:m,evidence:`${DAYS[i]} ${m}`,uncertainties:[]}))});

function setup(t,now='2026-11-04T16:30:00Z') {
  const f=harness(t,{now,caption:'',candidate:daily()});
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.sql("UPDATE weekly_specials SET week_start_date='2026-11-02',week_end_date='2026-11-08' WHERE id=9000");
  const readings=new Map();
  f.env.AI.run=async(_model,request)=>{
    f.state.aiCalls++;
    const text=JSON.stringify(request.messages);
    for(const [caption,reading] of readings) if(text.includes(caption)) return {response:JSON.stringify(reading)};
    throw Error('Unexpected caption');
  };
  f.scan=(at,posts)=>{
    f.state.now=Date.parse(at);
    f.state.posts=posts.map(({id,caption,created,updated=created,reading})=>{
      readings.set(caption,reading);
      return {id,message:caption,created_time:created,updated_time:updated,full_picture:`https://cdn.example/${id}.jpg`};
    });
    return f.run();
  };
  f.lunch=(day=3)=>f.slots(day,'lunch')[0];
  f.allDay=()=>f.slots(3,'all-day').slice(0,2).map(s=>s.content);
  f.conflicts=()=>f.sql("SELECT detail FROM special_import_events WHERE detail LIKE 'GUARDED_AUTO_CONFLICT%' ORDER BY id").map(e=>e.detail);
  f.revision=()=>f.sql("SELECT revision r FROM special_collections WHERE id='auto-week'")[0].r;
  return f;
}
const OLD={id:'d1',caption:'daily-original',created:'2026-11-04T15:00:00+0000',reading:daily()};
const NEW={id:'d2',caption:'daily-corrected',created:'2026-11-04T16:00:00+0000',reading:daily(offer(FIXED))};

// ── Daily posters ────────────────────────────────────────────────────────────

test('a newer daily poster replaces an older one still on the page, repeatedly and in either scan order',async t=>{
  for(const posts of [[OLD,NEW],[NEW,OLD]]) {
    const f=setup(t);
    await f.scan('2026-11-04T15:10:00Z',[OLD]);
    assert.equal(f.lunch().content,LUNCH);
    await f.scan('2026-11-04T16:10:00Z',posts);
    assert.equal(f.lunch().content,FIXED);
    assert.deepEqual(f.allDay(),[JAL,HAM]);
    assert.deepEqual(f.conflicts(),[]);
    const revision=f.revision();
    await f.scan('2026-11-04T16:40:00Z',posts);
    assert.equal(f.revision(),revision,'a repeated scan writes nothing');
    assert.equal(f.lunch().content,FIXED);
  }
});
test('a first scan seeing both posters publishes only the newer',async t=>{
  const f=setup(t);
  await f.scan('2026-11-04T16:10:00Z',[OLD,NEW]);
  assert.equal(f.lunch().content,FIXED);
  assert.deepEqual(f.conflicts(),[]);
});
test('a later comment on the older poster does not make it the newest',async t=>{
  const f=setup(t);
  await f.scan('2026-11-04T16:10:00Z',[OLD,NEW]);
  await f.scan('2026-11-04T17:10:00Z',[{...OLD,updated:'2026-11-04T17:00:00+0000'},NEW]);
  assert.equal(f.lunch().content,FIXED);
});
test('an older poster actually edited later becomes the newest',async t=>{
  const f=setup(t);
  await f.scan('2026-11-04T16:10:00Z',[OLD,NEW]);
  const edited='Reuben with Chips and a Drink $8.50';
  await f.scan('2026-11-04T17:10:00Z',[{...OLD,caption:'daily-reworded',updated:'2026-11-04T17:00:00+0000',reading:daily(offer(edited))},NEW]);
  assert.equal(f.lunch().content,edited);
});
test('posters with the same posting time still conflict and hold that service',async t=>{
  const f=setup(t);
  await f.scan('2026-11-04T16:10:00Z',[{...OLD,created:NEW.created},NEW]);
  assert.equal(f.lunch().content,'');
  assert.match(f.conflicts()[0],/Conflicting source offers/);
  assert.deepEqual(f.allDay(),[JAL,HAM],'agreeing offers still publish');
});
test('without verified times the planner still treats different offers as a conflict',()=>{
  const c=raw=>({...raw,evidence_version:2});
  const plan=reconcilePosterEvidence([c(daily()),c(daily(offer(FIXED)))],3,[],{today:'2026-11-04',verifiedSameDaySources:new Set([0,1])});
  assert.equal(plan.targets.some(x=>x.service==='lunch'),false);
  assert.ok(plan.unresolvedTargets.some(x=>x.reason==='Conflicting source offers'));
});
test('a newer poster with an uncertain offer does not lose to the older value',async t=>{
  const f=setup(t);
  await f.scan('2026-11-04T15:10:00Z',[OLD]);
  const reading=daily(offer(FIXED,['Price partly obscured']));
  await f.scan('2026-11-04T16:10:00Z',[OLD,{...NEW,reading}]);
  assert.equal(f.lunch().content,LUNCH,'the existing value stays while the newest reading is uncertain');
  assert.match(f.conflicts().at(-1),/Uncertain extracted offer/);
});
test('an older poster with an uncertain offer does not block the newer verified offer',async t=>{
  const f=setup(t);
  const reading=daily(offer(LUNCH,['Price partly obscured']));
  await f.scan('2026-11-04T16:10:00Z',[{...OLD,reading},NEW]);
  assert.equal(f.lunch().content,FIXED);
  assert.doesNotMatch(f.conflicts().join(),/Uncertain extracted offer/);
});
test('a newer poster covering only one service leaves the older poster for the others',async t=>{
  const f=setup(t);
  await f.scan('2026-11-04T15:10:00Z',[OLD]);
  const nightOnly={day_of_week:3,day_evidence:'WEDNESDAY',poster_evidence:'WEDNESDAY LUNCH SPECIAL 11-1:30',delivery:none,offers:[{...offer(FIXED),service_time:'11-1:30',service_evidence:'11-1:30'}]};
  await f.scan('2026-11-04T16:10:00Z',[OLD,{...NEW,reading:nightOnly}]);
  assert.equal(f.lunch().content,FIXED);
  assert.deepEqual(f.allDay(),[JAL,HAM]);
});

// ── Weekly posters ───────────────────────────────────────────────────────────

const W_OLD={id:'w1',caption:'weekly-original',created:'2026-11-02T14:51:00+0000',reading:weekly()};
const CHANGED=['Patty Melt and a Drink',...MEALS.slice(1)];
const W_NEW={id:'w2',caption:'weekly-corrected',created:'2026-11-02T15:30:00+0000',reading:weekly(CHANGED)};
test('a newer weekly poster replaces an older one still on the page, without a conflict',async t=>{
  const f=setup(t,'2026-11-02T15:00:00Z');
  await f.scan('2026-11-02T15:00:00Z',[W_OLD]);
  assert.equal(f.lunch(1).content,MEALS[0]);
  await f.scan('2026-11-02T15:40:00Z',[W_OLD,W_NEW]);
  assert.equal(f.lunch(1).content,CHANGED[0]);
  assert.equal(f.lunch(2).content,MEALS[1]);
  const revision=f.revision();
  await f.scan('2026-11-02T16:10:00Z',[W_OLD,W_NEW]);
  assert.equal(f.revision(),revision,'a repeated scan writes nothing');
});
test('weekly posters with the same posting time still conflict on the differing day',async t=>{
  const f=setup(t,'2026-11-02T15:00:00Z');
  await f.scan('2026-11-02T15:40:00Z',[{...W_OLD,created:W_NEW.created},W_NEW]);
  assert.equal(f.lunch(1).content,'');
  assert.equal(f.lunch(2).content,MEALS[1]);
});
test('a newer poster omitting a weekday leaves the older poster for that day',async t=>{
  const f=setup(t,'2026-11-02T15:00:00Z');
  const partial=weekly(CHANGED);partial.entries=partial.entries.slice(0,1);
  await f.scan('2026-11-02T15:40:00Z',[W_OLD,{...W_NEW,reading:partial}]);
  assert.equal(f.lunch(1).content,CHANGED[0]);
  assert.equal(f.lunch(3).content,MEALS[2]);
});

// ── Precedence and protection are unchanged ──────────────────────────────────

const setLunch=(f,sql,...args)=>f.sql(`UPDATE special_slots SET ${sql} WHERE position=1 AND group_id IN
  (SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=3 AND service='lunch')`,...args);
test('a same-day daily value still outranks a newer corrected weekly poster',async t=>{
  const f=setup(t);
  const fixed=['Patty Melt and a Drink','Taco Salad and a Drink','Reuben and a Drink','Meatloaf and a Drink','Fish Fry and a Drink'];
  const w={id:'w2',caption:'weekly-corrected',created:'2026-11-04T16:00:00+0000',reading:weekly(fixed)};
  await f.scan('2026-11-04T15:10:00Z',[OLD]);
  await f.scan('2026-11-04T16:10:00Z',[OLD,w]);
  assert.equal(f.lunch().content,LUNCH);
});
test('a locked special is never replaced by a newer poster until staff unlock it',async t=>{
  const f=setup(t);
  setLunch(f,"content='Staff special $8.00',origin='manual',manual_locked=1");
  const before=f.lunch();
  await f.scan('2026-11-04T16:10:00Z',[OLD,NEW]);
  await f.scan('2026-11-04T16:40:00Z',[OLD,NEW]);
  assert.deepEqual(f.lunch(),before);
});
test('a post created after an unlocked manual edit replaces it; an older one never does',async t=>{
  const f=setup(t);
  setLunch(f,"content='Staff special $8.00',origin='manual',manual_locked=0,manual_edited_at='2026-11-04T15:30:00.000Z'");
  await f.scan('2026-11-04T15:40:00Z',[OLD]);
  assert.equal(f.lunch().content,'Staff special $8.00','posted 15:00, before the edit');
  await f.scan('2026-11-04T16:10:00Z',[OLD,NEW]);
  assert.equal(f.lunch().content,FIXED,'posted 16:00, after the edit');
  assert.equal(f.lunch().manual_edited_at,null);
});
