import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {harness} from './test-fixture.js';
import {runImportPipeline} from './worker.js';
import {dailyPosterWeekday} from './guarded-auto.js';
import {dispatchVerifiedAlerts} from './alert-runtime.js';
import {ALERT_GRACE_MS} from './alert-store.js';
import {alertMessage} from './alert-email.js';

// The newest verified poster controls what customers see. A verified meal
// printing no price publishes without one and staff are notified; an old price never
// moves to another meal. AI responses are mocked; these exercise reconciliation and alerts.
const MEALS=[
  'Chicken Bacon Ranch Wrap with Chips and a Drink $9.75',
  'Taco Salad and a Drink $9.75',
  'Hot Ham and Cheese with Fries and a Drink $9.75',
  'Meatloaf with Mashed Potatoes and a Drink $9.75',
  'Fish Fry with Coleslaw and a Drink $9.75',
];
const DAYS=['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'];
const bare=meal=>meal.replace(/ \$[\d.]+$/,'');
const weekly=(meals=MEALS)=>({type:'weekly-lunch',poster_evidence:'WEEKLY LUNCH SPECIALS 11/2-11/6 11am-1:30pm',date_range:'11/2-11/6',service_time:'11am-1:30pm',
  entries:meals.map((m,i)=>({day_of_week:i+1,content:m,evidence:`${DAYS[i]} ${m}`,uncertainties:[]}))});
const offer=content=>({content,evidence:content,service_time:'',service_evidence:'',date_evidence:'',uncertainties:[]});
const JALAPENO='Jalapeno Burger with Side Salad, Chili or Coleslaw $10.25',HAM='Grilled Ham and Cheese with Cup of Chili or Coleslaw $7.25';
const none={status:'none',evidence:'',date_evidence:'',uncertainties:[]};
const daily=(first,{dated=false}={})=>({day_of_week:dated?1:-1,day_evidence:dated?'MONDAY':'',poster_evidence:dated?'MONDAY LUNCH SPECIALS':'DAILY SPECIALS',delivery:none,offers:[offer(first),offer(JALAPENO),offer(HAM)]});

function setup(t) {
  let db;t.after(()=>db?.close());
  const f=harness(t,{now:'2026-11-02T15:20:00Z',caption:'',candidate:weekly()});
  db=new DatabaseSync(f.path);
  db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT); INSERT OR REPLACE INTO settings VALUES('delivery_display','auto');");
  for(const name of ['0022_delivery_automation.sql','0023_facebook_alert_incidents.sql','0024_facebook_alert_evidence.sql'])
    db.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
  const DB={prepare(query) {
    return {sql:query,args:[],bind(...args){this.args=args;return this;},
      values(){return Object.fromEntries(this.args.map((v,i)=>[String(i+1),v]));},
      async first(){return db.prepare(query).get(this.values())??null;},
      async all(){return {results:db.prepare(query).all(this.values())};},
      async run(){return {meta:{changes:Number(db.prepare(query).run(this.values()).changes)}};}};
  },async batch(statements) {
    db.exec('BEGIN');
    try {
      const result=statements.map(s=>{
        const q=db.prepare(s.sql),values=s.values();
        if(/^\s*SELECT/i.test(s.sql)) return {results:q.all(values),meta:{changes:0}};
        return {results:[],meta:{changes:Number(q.run(values).changes)}};
      });db.exec('COMMIT');return result;
    } catch(e) {db.exec('ROLLBACK');throw e;}
  }};
  Object.assign(f.env,{DB,SPECIALS_ALERT_MODE:'MOCK',SPECIALS_EVIDENCE_VERSION:'2'});
  db.exec("UPDATE weekly_specials SET week_start_date='2026-11-02',week_end_date='2026-11-08' WHERE id=9000");
  const readings=new Map();
  f.env.AI.run=async(_model,request)=>{
    f.state.aiCalls++;
    const text=JSON.stringify(request.messages);
    for(const [caption,reading] of readings) if(text.includes(caption)) return {response:JSON.stringify(reading)};
    throw Error('Unexpected caption');
  };
  const sent=[];
  const scan=async posts=>{
    f.state.posts=posts.map(([id,caption,at,reading])=>{
      readings.set(caption,reading);
      return {id,message:caption,created_time:at,updated_time:at,full_picture:`https://cdn.example/${id}.jpg`};
    });
    return runImportPipeline(f.env,{send:async m=>sent.push(m)});
  };
  const lunch=day=>db.prepare(`SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id
    WHERE g.collection_id='auto-week' AND g.day_of_week=? AND g.service='lunch' AND s.position=1`).get(day);
  const setLunch=(day,sql,...args)=>db.prepare(`UPDATE special_slots SET ${sql} WHERE position=1 AND group_id IN
    (SELECT id FROM special_groups WHERE collection_id='auto-week' AND day_of_week=? AND service='lunch')`).run(...args,day);
  return {...f,db,sent,scan,lunch,setLunch,
    advance:ms=>{f.state.now+=ms;},
    send:()=>dispatchVerifiedAlerts(f.env,{send:async m=>sent.push(m)}),
    revision:()=>db.prepare("SELECT revision r FROM special_collections WHERE id='auto-week'").get().r,
    weekly:()=>db.prepare("SELECT * FROM facebook_alert_incidents WHERE scope='weekly' ORDER BY state='attention' DESC,observed_ms DESC").get()};
}
const ORIGINAL=['w1','weekly-original','2026-11-02T14:51:00+0000'];
const CORRECTED=['w2','weekly-corrected','2026-11-02T15:30:00+0000'];
const DAILY=['d1','daily-poster','2026-11-02T15:10:00+0000'];
const LATER=20*60000;

// ── Priced weekly, then a newer corrected weekly ─────────────────────────────

test('the newest poster controls: a priceless correction replaces the old meal, repeatedly',async t=>{
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly()]]);
  MEALS.forEach((m,i)=>assert.equal(f.lunch(i+1).content,m));
  const fixed=['Chicken Alfredo with Breadsticks',...MEALS.slice(1).map(bare)];
  f.advance(LATER);
  await f.scan([[...CORRECTED,weekly(fixed)]]);
  fixed.forEach((m,i)=>{const s=f.lunch(i+1);assert.equal(s.content,m);assert.equal(s.origin,'automation');assert.equal(s.last_auto_value,m);});
  assert.doesNotMatch(f.lunch(1).content,/\$/,'an old price is never moved to another meal');
  const revision=f.revision();
  f.advance(LATER);await f.scan([[...CORRECTED,weekly(fixed)]]);
  assert.equal(f.revision(),revision,'a repeated scan writes nothing');
});
test('removing a price is not silent: staff are alerted once with the reason',async t=>{
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly()]]);
  const fixed=MEALS.map(bare);
  f.advance(LATER);
  await f.scan([[...CORRECTED,weekly(fixed)]]);
  assert.match(f.db.prepare("SELECT detail FROM special_import_events WHERE detail LIKE 'GUARDED_WEEKLY_LUNCH:%' ORDER BY id DESC").get().detail,/price removed: 1,2,3,4,5$/);
  f.advance(ALERT_GRACE_MS);await f.scan([[...CORRECTED,weekly(fixed)]]);await f.send();
  assert.equal(f.weekly().state,'attention');
  assert.equal(f.sent.length,1);
  assert.match(JSON.stringify(f.sent[0]),/Published the newest poster without a price, replacing a priced special/);
  f.advance(LATER);await f.scan([[...CORRECTED,weekly(fixed)]]);await f.send();
  assert.equal(f.sent.length,1,'a repeated scan does not send again');
});
test('a normal priceless weekly poster filling blank slots raises no price alert',async t=>{
  const f=setup(t);
  const fixed=MEALS.map(bare);
  await f.scan([[...ORIGINAL,weekly(fixed)]]);
  f.advance(ALERT_GRACE_MS);await f.scan([[...ORIGINAL,weekly(fixed)]]);await f.send();
  fixed.forEach((m,i)=>assert.equal(f.lunch(i+1).content,m));
  assert.equal(f.sent.length,0);
});
test('a verified weekly row without a price publishes beside priced rows, and staff are told',async t=>{
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly()]]);
  const meals=['Chicken Alfredo with Breadsticks',MEALS[1].replace('9.75','11.00'),...MEALS.slice(2)];
  f.advance(LATER);await f.scan([[...CORRECTED,weekly(meals)]]);
  assert.equal(f.lunch(1).content,meals[0],'no price invented or inherited');
  assert.equal(f.lunch(2).content,meals[1]);
  f.advance(ALERT_GRACE_MS);await f.scan([[...CORRECTED,weekly(meals)]]);await f.send();
  assert.equal(f.sent.length,1);
  assert.match(JSON.stringify(f.sent[0]),/Published the newest poster without a price/);
});
test('a first weekly poster mixing priced and unpriced rows publishes all and notifies staff once',async t=>{
  const f=setup(t);
  const meals=[bare(MEALS[0]),...MEALS.slice(1)];
  await f.scan([[...ORIGINAL,weekly(meals)]]);
  meals.forEach((m,i)=>assert.equal(f.lunch(i+1).content,m));
  f.advance(ALERT_GRACE_MS);await f.scan([[...ORIGINAL,weekly(meals)]]);await f.send();
  assert.equal(f.sent.length,1);
  assert.match(JSON.stringify(f.sent[0]),/Published a verified meal without a price; other meals on this poster have prices/);
  f.advance(LATER);await f.scan([[...ORIGINAL,weekly(meals)]]);await f.send();
  assert.equal(f.sent.length,1);
});
test('an uncertain weekly row without a price is still held',async t=>{
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly()]]);
  const reading=weekly([bare(MEALS[0]),...MEALS.slice(1)]);reading.entries[0].uncertainties=['Price may be cut off'];
  f.advance(LATER);await f.scan([[...CORRECTED,reading]]);
  assert.equal(f.lunch(1).content,MEALS[0]);
});
test('a later corrected poster that prints the price replaces a priceless value',async t=>{
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly()]]);
  f.advance(LATER);await f.scan([[...CORRECTED,weekly(MEALS.map(bare))]]);
  const priced=MEALS.map(m=>m.replace('9.75','11.00'));
  f.advance(LATER);await f.scan([['w3','weekly-third','2026-11-02T15:50:00+0000',weekly(priced)]]);
  priced.forEach((m,i)=>assert.equal(f.lunch(i+1).content,m));
});

// ── A daily poster with no prices ────────────────────────────────────────────

const unpriced=(first,second=bare(JALAPENO),third=bare(HAM))=>({...daily(first,{dated:true}),offers:[offer(first),offer(second),offer(third)]});
test('a daily poster printing no prices publishes its meals and notifies staff once',async t=>{
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly()]]);
  const NEW='Chicken Alfredo with Breadsticks';
  const post=[...DAILY,unpriced(NEW)];
  f.advance(LATER);await f.scan([post]);
  assert.equal(f.lunch(1).content,NEW);
  assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>s.content),[bare(JALAPENO),bare(HAM)]);
  const revision=f.revision();
  f.advance(ALERT_GRACE_MS);await f.scan([post]);await f.send();
  assert.equal(f.revision(),revision);
  assert.equal(f.sent.length,1);
  assert.match(alertMessage(f.sent[0].day,f.sent[0].code,{detail:f.sent[0].detail}).text,/Published without a printed price: Monday Lunch #1/);
  f.advance(LATER);await f.scan([post]);await f.send();
  assert.equal(f.sent.length,1);
});
test('a verified daily meal without a price publishes beside priced meals, and staff are told once',async t=>{
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly()]]);
  const NEW='Chicken Alfredo with Breadsticks';
  const post=[...DAILY,unpriced(NEW,JALAPENO,HAM)];
  f.advance(LATER);await f.scan([post]);
  assert.equal(f.lunch(1).content,NEW,'no price invented or inherited');
  assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>s.content),[JALAPENO,HAM]);
  f.advance(ALERT_GRACE_MS);await f.scan([post]);await f.send();
  assert.equal(f.sent.length,1);
  assert.match(alertMessage(f.sent[0].day,f.sent[0].code,{detail:f.sent[0].detail}).text,/Published without a printed price: Monday Lunch #1/);
});
test('an undated daily poster with one unpriced meal keeps its layout',async t=>{
  const f=setup(t);
  const NEW='Chicken Alfredo with Breadsticks';
  await f.scan([[...DAILY,{...daily(NEW),offers:[offer(NEW),offer(JALAPENO),offer(HAM)]}]]);
  assert.equal(f.lunch(1).content,NEW);
  assert.deepEqual(f.slots(1,'all-day').slice(0,2).map(s=>s.content),[JALAPENO,HAM]);
});
for(const [name,raw] of [
  ['the heading prints a price',()=>({...unpriced('Chicken Alfredo with Breadsticks'),poster_evidence:'MONDAY LUNCH SPECIALS $9.75'})],
  ['a price without its $ is printed',()=>unpriced('Chicken Alfredo with Breadsticks 9.75')],
  ['the meal has no verbatim evidence',()=>({...unpriced('Chicken Alfredo with Breadsticks'),offers:[{...offer('Chicken Alfredo with Breadsticks'),evidence:''},offer(bare(JALAPENO)),offer(bare(HAM))]})],
  ['the meal differs from its evidence',()=>({...unpriced('Chicken Alfredo with Breadsticks'),offers:[{...offer('Chicken Alfredo with Breadsticks'),evidence:'CHICKEN PARMESAN'},offer(bare(JALAPENO)),offer(bare(HAM))]})],
  ['the reading is uncertain',()=>({...unpriced('Chicken Alfredo with Breadsticks'),offers:[{...offer('Chicken Alfredo with Breadsticks'),uncertainties:['Price may be cut off']},offer(bare(JALAPENO)),offer(bare(HAM))]})],
]) test(`an unpriced lunch is held when ${name}`,async t=>{
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly()]]);
  f.advance(LATER);await f.scan([[...DAILY,raw()]]);
  assert.equal(f.lunch(1).content,MEALS[0]);
});

// ── Undated daily poster, then a corrected weekly ────────────────────────────

for(const dated of [false,true]) {
  const label=dated?'dated':'undated';
  const seed=async f=>{
    await f.scan([[...ORIGINAL,weekly()],[...DAILY,daily(MEALS[0],{dated})]]);
    assert.equal(f.lunch(1).content,MEALS[0]);
  };
  const current=[...DAILY,daily(MEALS[0],{dated})];
  test(`an identical ${label} daily price survives a fully priceless corrected weekly`,async t=>{
    const f=setup(t);await seed(f);
    const meals=MEALS.map(bare);
    f.advance(LATER);await f.scan([current,[...CORRECTED,weekly(meals)]]);
    assert.equal(f.lunch(1).content,MEALS[0],'daily outranks weekly');
    assert.deepEqual([2,3,4,5].map(d=>f.lunch(d).content),meals.slice(1),'other days take the newest poster');
  });
  test(`an identical ${label} daily price is not replaced by a differently priced corrected weekly`,async t=>{
    const f=setup(t);await seed(f);
    const meals=[MEALS[0].replace('9.75','11.00'),...MEALS.slice(1)];
    f.advance(LATER);await f.scan([current,[...CORRECTED,weekly(meals)]]);
    assert.equal(f.lunch(1).content,MEALS[0],'daily outranks weekly');
    assert.deepEqual([2,3,4,5].map(d=>f.lunch(d).content),MEALS.slice(1));
    f.advance(ALERT_GRACE_MS);await f.scan([current,[...CORRECTED,weekly(meals)]]);await f.send();
    assert.equal(f.sent.length,0,'daily precedence is not a failure');
  });
}
test('a current daily poster only protects its own weekday',async t=>{
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly()],[...DAILY,daily(MEALS[0])]]);
  const meals=MEALS.map(m=>m.replace('9.75','11.00'));
  f.advance(LATER);await f.scan([[...DAILY,daily(MEALS[0])],[...CORRECTED,weekly(meals)]]);
  assert.equal(f.lunch(1).content,MEALS[0]);
  [2,3,4,5].forEach(d=>assert.equal(f.lunch(d).content,meals[d-1]));
});
test('an undated post with no offers protects nothing',async t=>{
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly()]]);
  const meals=MEALS.map(m=>m.replace('9.75','11.00'));
  const photo=['p1','unrelated-photo','2026-11-02T15:10:00+0000',{day_of_week:-1,day_evidence:'',poster_evidence:'',delivery:none,offers:[]}];
  f.advance(LATER);await f.scan([photo,[...CORRECTED,weekly(meals)]]);
  assert.equal(f.lunch(1).content,meals[0]);
});
test('the undated weekday comes only from a verified creation day',()=>{
  const today='2026-11-04',offers=[{content:'A $1'}];
  assert.equal(dailyPosterWeekday({day_of_week:-1,offers},'2026-11-04T15:48:06+0000',today),3);
  assert.equal(dailyPosterWeekday({day_of_week:-1,offers},'2026-11-03T15:48:06+0000',today),null,'another day');
  assert.equal(dailyPosterWeekday({day_of_week:-1,offers},'not a date',today),null,'invalid timestamp');
  assert.equal(dailyPosterWeekday({day_of_week:-1,offers:[]},'2026-11-04T15:48:06+0000',today),null,'no offers');
  assert.equal(dailyPosterWeekday({day_of_week:2,offers},'2026-11-04T15:48:06+0000',today),2,'a printed day stands');
  assert.equal(dailyPosterWeekday({type:'weekly-lunch',entries:[]},'2026-11-04T15:48:06+0000',today),null,'not daily');
});

// ── Normal precedence and protection ─────────────────────────────────────────

test('a clean daily poster still prices and replaces a priceless weekly value',async t=>{
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly(MEALS.map(bare))]]);
  assert.equal(f.lunch(1).content,bare(MEALS[0]));
  const priced='Patty Melt with Fries and a Drink $10.25';
  f.advance(LATER);await f.scan([[...DAILY,daily(priced)]]);
  assert.equal(f.lunch(1).content,priced);
});
test('a staff-locked lunch is unchanged by a priced or priceless corrected poster, repeatedly',async t=>{
  const STAFF='Staff Monday meal $8.00';
  const f=setup(t);
  await f.scan([[...ORIGINAL,weekly()]]);
  f.setLunch(1,"content=?,origin='manual',manual_locked=1",STAFF);
  for(const meals of [MEALS.map(bare),MEALS.map(m=>m.replace('9.75','11.00'))]) {
    f.advance(LATER);await f.scan([[...CORRECTED,weekly(meals)]]);
    const s=f.lunch(1);assert.equal(s.content,STAFF);assert.equal(s.origin,'manual');assert.equal(s.manual_locked,1);
  }
});
