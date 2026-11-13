import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {harness,offer,poster} from './test-fixture.js';
import {runImportPipeline} from './worker.js';
import {ensureAutomaticWeek} from './auto-week.js';
import {dispatchVerifiedAlerts} from './alert-runtime.js';
import {ALERT_GRACE_MS} from './alert-store.js';
import {alertMessage} from './alert-email.js';
import {validateWingNight,formatWingNight} from './wing-night.js';
import {canonicalizeSlotContent} from './reconcile.js';
import {reconcileWingWednesday,recordWingScan} from './wing-wednesday.js';
import {readWingAttention,WING_HOLD} from './wing-review.js';
import {fixture} from '../../tests/specials-fixture.mjs';
import {loadTs} from '../../tests/load-ts.mjs';
import {parseWingSauces} from '../../src/lib/wing-wednesday.js';
// Facebook is the canonical source (docs/facebook-specials-source-of-truth.md): a staff
// correction is kept only against posts published before its recorded edit time. Staff
// corrections here are stamped manual_edited_at='2099-12-31…' (after every post in the test).
const store=loadTs('src/lib/specials-store.ts');

const OPTIONS='ww-live:ww-default:wings', SAUCES='ww-live:ww-default:sauces';
const wingText='Wing Night — Bone-In $.89 each / Boneless $.99 each';
const options=f=>f.sql('SELECT content FROM special_slots WHERE group_id=? ORDER BY position',OPTIONS).map(s=>s.content);
const sauces=f=>parseWingSauces(f.sql('SELECT content FROM special_slots WHERE group_id=? AND position=1',SAUCES)[0].content);
const decisions=f=>f.sql('SELECT outcome,detail FROM wing_wednesday_decisions ORDER BY rowid');
const nightPoster=(text=wingText,evidence=text)=>poster(3,'Night Specials',[offer(text,evidence,'5-10 PM')]);
const pizza=()=>poster(3,'Pizza Night',[offer('Pizza Night 16" Pizza $14','Pizza Night 16" Pizza $14','5-10 PM')]);
const later=(f,id,minutes)=>{
  const at=new Date(Date.parse(f.state.posts[0].created_time)+minutes*60000).toISOString();
  f.state.posts=[{...f.state.posts[0],id,created_time:at,updated_time:at}];
  f.state.now=Math.max(f.state.now,Date.parse(at)+60000);
};
const contracts=[['contract 1',{}],['contract 2',{SPECIALS_EVIDENCE_VERSION:'2',SPECIALS_VERIFICATION_STRATEGY:'conditional'}]];

// ── Wording and price association ──
test('Wing Night and Wing Wednesday keep the printed name; prices stay with their labels',()=>{
  assert.equal(formatWingNight('Wing Night Bone-In $1 each Boneless $2 each'),'Wing Night!\nBone-In Wings $1 each\nBoneless Wings $2 each');
  assert.equal(formatWingNight('WING WEDNESDAY Boneless $2 each Bone-In $1 each'),'Wing Wednesday!\nBone-In Wings $1 each\nBoneless Wings $2 each');
  assert.equal(formatWingNight('Wing Wednesday $2 Boneless Wings $1 Bone In Wings'),'Wing Wednesday!\nBone-In Wings $1\nBoneless Wings $2');
  assert.equal(canonicalizeSlotContent('Wing Wednesday Bone-In $1 Boneless $2',3,'nightly'),'Wing Wednesday!\nBone-In Wings $1\nBoneless Wings $2');
});
test('a price swapped between wing types, or missing a label, is never accepted',()=>{
  assert.equal(validateWingNight('Wing Night Bone-In $1 Boneless $2','Wing Night Bone-In $2 Boneless $1'),null);
  assert.equal(validateWingNight('Wing Wednesday $1 $2','Wing Wednesday $1 $2'),null);
  assert.equal(validateWingNight('Wing Wednesday Bone-In $1','Wing Wednesday Bone-In $1'),null);
});
test('the printed evidence decides which name is published',()=>{
  assert.match(validateWingNight('Wing Night Bone-In $1 Boneless $2','Wing Wednesday Bone-In $1 Boneless $2'),/^Wing Wednesday!/);
});

// ── One poster, both destinations, no second reading ──
for(const [name,extra] of contracts) {
  test(`${name}: a conflicting boneless reading does not block a corroborated bone-in price`,async t=>{
    const f=harness(t,{candidate:nightPoster('Wing Night Bone-In $1 each / Boneless $2 each',
      'Wing Night Bone-In $1 each / Boneless $3 each')});
    Object.assign(f.env,extra);
    await f.run();
    assert.deepEqual(options(f).slice(0,2),['Bone-In Wings $1 each','Boneless Wings']);
    assert.equal((await readWingAttention(f.env))?.unresolved_mask,2);
  });
  for(const heading of ['Wing Night','Wing Wednesday']) test(`${name}: a ${heading} poster updates the nightly special and the section with one AI call`,async t=>{
    const text=`${heading} — Bone-In $.89 each / Boneless $.99 each`;
    const f=harness(t,{candidate:nightPoster(text)});Object.assign(f.env,extra);
    await f.run();
    assert.equal(f.slots()[0].content,`${heading}!\nBone-In Wings $.89 each\nBoneless Wings $.99 each`);
    assert.deepEqual(options(f),['Bone-In Wings $.89 each','Boneless Wings $.99 each','','']);
    assert.equal(sauces(f).length,16);assert.equal(f.state.aiCalls,1);
    assert.equal(decisions(f)[0].outcome,'published');
  });
  test(`${name}: another Wednesday promotion still publishes nightly, leaves the section alone and asks for review`,async t=>{
    const f=harness(t,{candidate:pizza()});Object.assign(f.env,extra);
    await f.run();
    assert.equal(f.slots()[0].content,'Pizza Night 16" Pizza $14');
    assert.deepEqual(options(f),['Bone-In Wings','Boneless Wings','','']);
    assert.equal(sauces(f).length,16);assert.equal(f.state.aiCalls,1);
    assert.deepEqual(decisions(f).map(d=>d.detail),[WING_HOLD.promotion]);
  });
  test(`${name}: uncertain wing prices are held from both destinations`,async t=>{
    const f=harness(t,{candidate:nightPoster('Wing Night Bone-In Boneless')});Object.assign(f.env,extra);
    await f.run();
    assert.equal(f.slots()[0].content,'');
    assert.deepEqual(options(f).slice(0,2),['Bone-In Wings','Boneless Wings']);
    assert.equal(decisions(f)[0].outcome,'held');
  });
}
test('a daytime Wednesday poster says nothing about wings: no decision and no review',async t=>{
  const f=harness(t,{candidate:poster(3,'Specials',[offer('Quesadilla $9.75','Quesadilla $9.75','11-1:30'),offer('Burger $10.25','Burger $10.25'),offer('Sandwich $7.25','Sandwich $7.25')])});
  await f.run();
  assert.equal(decisions(f).length,0);assert.equal(await readWingAttention(f.env),null);
});
test('a staff-locked nightly value is an intentional choice, not a promotion to report',async t=>{
  const f=harness(t,{candidate:pizza()});
  f.sql("UPDATE special_slots SET manual_edited_at='2099-12-31T00:00:00.000Z',content='Staff special',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",f.slots()[0].group_id);
  await f.run();
  assert.equal(f.slots()[0].content,'Staff special');assert.equal(decisions(f).length,0);
});
test('destinations stay independent: a locked nightly slot keeps its text while the section updates, and the reverse',async t=>{
  const one=harness(t,{candidate:nightPoster()});
  one.sql("UPDATE special_slots SET manual_edited_at='2099-12-31T00:00:00.000Z',content='Staff special',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",one.slots()[0].group_id);
  await one.run();
  assert.equal(one.slots()[0].content,'Staff special');assert.equal(options(one)[0],'Bone-In Wings $.89 each');
  const two=harness(t,{candidate:nightPoster()});
  await ensureAutomaticWeek(two.env,{today:'2030-01-09',weekday:3,hour:9});
  const live=await store.readCollection(two.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $1.10 each';await store.saveCollection(two.env,live);
  await two.run();
  assert.match(two.slots()[0].content,/^Wing Night!/);assert.equal(options(two)[0],'Bone-In Wings $.89 each');
  assert.equal(decisions(two)[0].outcome,'published');
});
test('same-time posters that disagree are held; a later verified poster replaces and ends the review',async t=>{
  const f=harness(t,{candidate:nightPoster()});
  await f.run();
  const first=f.sql('SELECT * FROM special_imports')[0];
  const copy={...first,id:'rival',fb_post_id:'rival-post',candidate_json:JSON.stringify(nightPoster('Wing Night Bone-In $1 Boneless $2'))};
  f.sql(`INSERT INTO special_imports(${Object.keys(copy).join(',')}) VALUES(${Object.keys(copy).map(()=>'?').join(',')})`,...Object.values(copy));
  f.sql('DELETE FROM wing_wednesday_decisions');
  await reconcileWingWednesday(f.env,{today:'2030-01-09',sourceIds:[first.id,copy.id],scanToken:await recordWingScan(f.env,Date.now())});
  assert.equal(decisions(f)[0].detail,WING_HOLD.conflict);
  assert.ok(await readWingAttention(f.env));
  f.sql("DELETE FROM special_imports WHERE id='rival'");
  later(f,'p3',30);f.state.candidate=nightPoster('Wing Night Bone-In $1 each Boneless $2 each');
  await f.run();
  assert.equal(options(f)[0],'Bone-In Wings $1 each');
  assert.equal(await readWingAttention(f.env),null);
});
test('a failed section write is recorded and retried, and a retry that works ends the review',async t=>{
  const f=harness(t,{candidate:nightPoster()});
  await ensureAutomaticWeek(f.env,{today:'2030-01-09',weekday:3,hour:9});
  const batch=f.env.DB.batch;
  f.env.DB.batch=statements=>/wing_wednesday_decisions/.test(statements.at(-2)?.sql ?? '') ? Promise.reject(Error('down')) : batch.call(f.env.DB,statements);
  await f.run();
  assert.equal(decisions(f)[0].detail,WING_HOLD.unpublished);
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings','Boneless Wings']);
  assert.ok(await readWingAttention(f.env));
  f.env.DB.batch=batch;
  await f.run();
  assert.equal(decisions(f)[0].outcome,'published');assert.equal(options(f)[0],'Bone-In Wings $.89 each');
  assert.equal(await readWingAttention(f.env),null);
});
test('a failed Wing Wednesday write never retries a poster removed from the next complete scan',async t=>{
  const f=harness(t,{candidate:nightPoster()});
  await ensureAutomaticWeek(f.env,{today:'2030-01-09',weekday:3,hour:9});
  const batch=f.env.DB.batch;
  f.env.DB.batch=statements=>/wing_wednesday_decisions/.test(statements.at(-2)?.sql ?? '') ? Promise.reject(Error('down')) : batch.call(f.env.DB,statements);
  await f.run();
  assert.equal(decisions(f)[0].detail,WING_HOLD.unpublished);
  f.env.DB.batch=batch;
  f.state.posts=[];
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings','Boneless Wings']);
  assert.equal(decisions(f)[0].outcome,'held');
  assert.equal(f.state.aiCalls,1);
});
test('a newer complete empty scan fences a Wing publication already in progress',async t=>{
  const f=harness(t,{candidate:nightPoster()});
  const batch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{
    if(/wing_wednesday_decisions/.test(statements.at(-2)?.sql ?? '')) await recordWingScan(f.env,Date.now()+1);
    return batch.call(f.env.DB,statements);
  };
  await f.run();
  assert.match(f.slots()[0].content,/^Wing Night!/);
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings','Boneless Wings']);
  assert.equal(decisions(f).length,0);
});

// ── Sunday rollover ──
function sunday(t,hour=14) {
  const f=fixture(t);f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  // Chicago is UTC-6 in January.
  const clock=t.mock.method(Date,'now',()=>Date.parse(`2030-01-13T${String(hour+6).padStart(2,'0')}:00:00Z`));
  return {f,clock};
}
const prepare=async(f,hour=19)=>ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour});
const week=f=>f.sql("SELECT section_week_start,section_service_date,section_source FROM special_collections WHERE id='wing-wednesday'")[0];
test('a Sunday edit before 7 PM survives the rollover, and repeated provisioning, for the coming Wednesday',async t=>{
  const {f,clock}=sunday(t);
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $1.25 each';await store.saveCollection(f.env,live);
  assert.deepEqual(week(f),{section_week_start:'2030-01-14',section_service_date:'2030-01-16',section_source:'manual'});
  clock.mock.mockImplementation(()=>Date.parse('2030-01-14T01:00:00Z'));
  await prepare(f);await prepare(f);
  await ensureAutomaticWeek(f.env,{today:'2030-01-15',weekday:2,hour:12});
  assert.equal(options(f)[0],'Bone-In Wings $1.25 each');
  assert.equal(week(f).section_source,'manual');
});
test('next week still starts from recurring defaults, not last week\'s manual change',async t=>{
  const {f,clock}=sunday(t);
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $1.25 each';await store.saveCollection(f.env,live);
  clock.mock.mockImplementation(()=>Date.parse('2030-01-14T01:00:00Z'));
  await prepare(f);
  clock.mock.mockImplementation(()=>Date.parse('2030-01-21T01:00:00Z'));
  await ensureAutomaticWeek(f.env,{today:'2030-01-20',weekday:0,hour:19});
  assert.equal(options(f)[0],'Bone-In Wings');assert.equal(week(f).section_source,'recurring');
  assert.equal(week(f).section_service_date,'2030-01-23');
});
test('the Sunday editor starts from defaults, so last week\'s prices are not saved forward',async t=>{
  const {f}=sunday(t);
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $9 each';
  const defaults=await store.readCollection(f.env,'wing-wednesday-defaults');
  const at=new Date('2030-01-13T20:00:00Z');
  assert.equal(store.wingEditorValues(live,defaults,'2030-01-07',at).groups[0].slots[0].content,'Bone-In Wings');
  assert.equal(store.wingEditorValues(live,defaults,'2030-01-14',at).groups[0].slots[0].content,'Bone-In Wings $9 each','already this week');
  assert.equal(store.wingEditorValues(live,defaults,'2030-01-07',new Date('2030-01-10T20:00:00Z')).groups[0].slots[0].content,'Bone-In Wings $9 each','not Sunday');
});
test('a Thursday edit stays with its finished week and is replaced at the rollover',async t=>{
  const f=fixture(t);f.env.SPECIALS_IMPORT_MODE='GUARDED_AUTO';
  const clock=t.mock.method(Date,'now',()=>Date.parse('2030-01-14T01:00:00Z'));
  await prepare(f);
  clock.mock.mockImplementation(()=>Date.parse('2030-01-17T20:00:00Z'));
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $3 each';await store.saveCollection(f.env,live);
  assert.equal(week(f).section_week_start,'2030-01-14');
  clock.mock.mockImplementation(()=>Date.parse('2030-01-21T01:00:00Z'));
  await ensureAutomaticWeek(f.env,{today:'2030-01-20',weekday:0,hour:19});
  assert.equal(options(f)[0],'Bone-In Wings');
});

// ── Sauce edits and wing price ownership ──
const editSauces=async(f,text='Buffalo\nRanch')=>{
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups.find(g=>g.id===SAUCES).slots[0].content=text;
  await store.saveCollection(f.env,live);
};
const wingWeek=async(t,options)=>{
  const f=harness(t,{candidate:nightPoster(),...options});
  await ensureAutomaticWeek(f.env,{today:'2030-01-09',weekday:3,hour:9});
  return f;
};
const source=f=>f.sql("SELECT section_source FROM special_collections WHERE id='wing-wednesday'")[0].section_source;
test('a sauce-only edit keeps the sauces and lets a verified poster publish wing prices',async t=>{
  const f=await wingWeek(t);
  await editSauces(f);
  assert.equal(source(f),'recurring');
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings $.89 each','Boneless Wings $.99 each']);
  assert.deepEqual(sauces(f),['Buffalo','Ranch']);
  assert.equal(decisions(f)[0].outcome,'published');assert.equal(source(f),'facebook');
});
test('a sauce edit after publication leaves the prices automation-owned, so a newer poster still updates them',async t=>{
  const f=await wingWeek(t);
  await f.run();
  await editSauces(f);
  assert.equal(source(f),'facebook');
  const slot=f.sql('SELECT origin,manual_locked,manual_edited_at FROM special_slots WHERE group_id=? AND position=1',OPTIONS)[0];
  assert.deepEqual({...slot},{origin:'automation',manual_locked:0,manual_edited_at:null});
  later(f,'p2',30);
  f.state.candidate=nightPoster('Wing Night — Bone-In $1.05 each / Boneless $1.15 each');
  await f.run();
  assert.equal(options(f)[0],'Bone-In Wings $1.05 each');assert.deepEqual(sauces(f),['Buffalo','Ranch']);
});
const editOption=async(f,position,content)=>{
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups.find(g=>g.id===OPTIONS).slots[position-1].content=content;
  await store.saveCollection(f.env,live);
};
const slotOf=(f,position)=>f.sql('SELECT manual_locked,origin FROM special_slots WHERE group_id=? AND position=?',OPTIONS,position)[0];
test('a verified poster replaces staff prices on both options and keeps the sauces saved with them',async t=>{
  const f=await wingWeek(t);
  const live=await store.readCollection(f.env,'wing-wednesday');
  const group=live.groups.find(g=>g.id===OPTIONS);
  group.slots[0].content='Bone-In Wings $1.10 each';group.slots[1].content='Boneless Wings $1.20 each';
  live.groups.find(g=>g.id===SAUCES).slots[0].content='Buffalo';
  await store.saveCollection(f.env,live);
  assert.equal(source(f),'manual');
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings $.89 each','Boneless Wings $.99 each']);
  assert.deepEqual(sauces(f),['Buffalo']);assert.equal(decisions(f)[0].outcome,'published');assert.equal(source(f),'facebook');
});
test('a verified poster replaces a staff price however it was written, leaving one price',async t=>{
  for(const typed of ['Bone-In Wings $1.10','Bone-In Wings $1 per wing','Bone-In Wings $1.5 each','Bone-In Wings $1.25/each','$1.10 Bone-In Wings','Bone-In Wings 89 cents','Bone-In Wings 89¢','Bone-In Wings 2 for $3','Bone-In Wings - $1.10','Bone-In Wings @ $1']) {
    const f=await wingWeek(t);
    await editOption(f,1,typed);
    await f.run();
    assert.equal(options(f)[0],'Bone-In Wings $.89 each',typed);
    assert.equal(decisions(f)[0].outcome,'published',typed);
  }
});
test('a renamed item or new description keeps its text and still receives the verified price',async t=>{
  const f=await wingWeek(t);
  await editOption(f,1,'Jumbo Bone-In Wings\nTossed to order');
  await editOption(f,2,'Boneless Bites');
  assert.equal(source(f),'recurring');assert.equal(slotOf(f,1).manual_locked,0);
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Jumbo Bone-In Wings $.89 each\nTossed To Order','Boneless Bites $.99 each']);
  assert.equal(decisions(f)[0].outcome,'published');
});
test('a description added under a Facebook price is not a staff price: the next poster still updates it',async t=>{
  const f=await wingWeek(t);
  await f.run();
  await editOption(f,1,'Bone-In Wings $.89 each\nTossed to order');
  assert.equal(slotOf(f,1).manual_locked,0);assert.equal(source(f),'facebook');
  later(f,'p2',30);
  f.state.candidate=nightPoster('Wing Night — Bone-In $1.05 each / Boneless $1.15 each');
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings $1.05 each\nTossed To Order','Boneless Wings $1.15 each']);
});
test('a staff correction stands against the poster it corrected, until a newer verified poster replaces it',async t=>{
  const f=await wingWeek(t);
  await f.run();
  await editOption(f,1,'Bone-In Wings $.75 each');
  assert.equal(slotOf(f,1).manual_locked,1);assert.equal(source(f),'manual');
  f.state.now+=60000;
  await f.run();
  assert.equal(options(f)[0],'Bone-In Wings $.75 each','the same poster is not applied twice');
  later(f,'p2',30);
  f.state.candidate=nightPoster('Wing Night — Bone-In $1.05 each / Boneless $1.15 each');
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings $1.05 each','Boneless Wings $1.15 each']);
  assert.equal(slotOf(f,1).manual_locked,0);assert.equal(source(f),'facebook');
});
test('deleting a staff price hands that option back to Facebook',async t=>{
  const f=await wingWeek(t);
  await editOption(f,1,'Bone-In Wings $.75 each');
  await editOption(f,1,'Bone-In Wings');
  assert.equal(slotOf(f,1).manual_locked,0);assert.equal(source(f),'recurring');
  await f.run();
  assert.equal(options(f)[0],'Bone-In Wings $.89 each');
});
test('title and schedule edits do not block a verified poster',async t=>{
  const f=await wingWeek(t);
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.title='Wing Wednesday Night';live.schedule='Wednesdays 5–9 PM';
  await store.saveCollection(f.env,live);
  await f.run();
  assert.equal(options(f)[0],'Bone-In Wings $.89 each');assert.equal(decisions(f)[0].outcome,'published');
  assert.equal(f.sql("SELECT title FROM special_collections WHERE id='wing-wednesday'")[0].title,'Wing Wednesday Night');
});
test('a stale name edit is rejected and cannot overwrite a published price',async t=>{
  const f=await wingWeek(t);
  const stale=await store.readCollection(f.env,'wing-wednesday');
  await f.run();
  stale.groups.find(g=>g.id===OPTIONS).slots[0].content='Jumbo Bone-In Wings';
  await assert.rejects(store.saveCollection(f.env,stale),store.SpecialConflict);
  assert.equal(options(f)[0],'Bone-In Wings $.89 each');
});
test('a stale sauce save is rejected and cannot overwrite prices published since the form opened',async t=>{
  const f=await wingWeek(t);
  const stale=await store.readCollection(f.env,'wing-wednesday');
  await f.run();
  stale.groups.find(g=>g.id===SAUCES).slots[0].content='Buffalo';
  await assert.rejects(store.saveCollection(f.env,stale),store.SpecialConflict);
  assert.equal(options(f)[0],'Bone-In Wings $.89 each');assert.equal(sauces(f).length,16);
});
test('a sauce save during a poster publication makes the publication a no-op that retries cleanly',async t=>{
  const f=await wingWeek(t);
  const batch=f.env.DB.batch;let raced=false;
  f.env.DB.batch=async statements=>{
    if(!raced && statements.some(s=>s.sql.includes('COALESCE(?9,section_source)'))) {
      raced=true;f.env.DB.batch=batch;await editSauces(f);f.env.DB.batch=async next=>batch.call(f.env.DB,next);
    }
    return batch.call(f.env.DB,statements);
  };
  await f.run();
  assert.equal(raced,true);assert.deepEqual(sauces(f),['Buffalo','Ranch']);
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings','Boneless Wings'],'lost the race; nothing written');
  assert.equal(decisions(f).length,0,'undecided, so the next scan can publish');
  f.state.now+=60000;
  await f.run();
  assert.equal(options(f)[0],'Bone-In Wings $.89 each');assert.deepEqual(sauces(f),['Buffalo','Ranch']);
});
test('partial poster publishes bone-in and keeps boneless review after an unrelated staff price edit',async t=>{
  const f=await wingWeek(t,{candidate:nightPoster('Wing Night — Bone-In $.89 each / Boneless each','Wing Night Bone-In $.89 each')});
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings $.89 each','Boneless Wings']);
  assert.equal((await readWingAttention(f.env))?.detail,WING_HOLD.prices);
  await editSauces(f);
  assert.equal((await readWingAttention(f.env))?.detail,WING_HOLD.prices);
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups.find(g=>g.id===OPTIONS).slots[0].content='Bone-In Wings $1 each';await store.saveCollection(f.env,live);
  assert.equal((await readWingAttention(f.env))?.detail,WING_HOLD.prices);
  await editOption(f,2,'Boneless Wings $2 each');
  assert.equal(await readWingAttention(f.env),null);
});

test('partial poster independently publishes boneless and clears an older automatic bone-in price',async t=>{
  const f=await wingWeek(t);
  await f.run();
  later(f,'partial',30);
  f.state.candidate=nightPoster('Wing Night Bone-In / Boneless $1.25 each');
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings','Boneless Wings $1.25 each']);
  assert.equal((await readWingAttention(f.env))?.detail,WING_HOLD.prices);
});

// ── Facebook precedence and wing types ──
test('unrelated staff edits survive a poster that replaces the price',async t=>{
  const f=await wingWeek(t);
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.title='Wing Night Special';live.schedule='Wednesdays 5–9 PM';
  const group=live.groups.find(g=>g.id===OPTIONS);
  group.slots[0].content='Jumbo Bone-In Wings $1 per wing\nTossed to order';group.slots[1].content='Boneless Bites\nHand breaded';
  live.groups.find(g=>g.id===SAUCES).slots[0].content='Buffalo\nRanch';
  await store.saveCollection(f.env,live);
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Jumbo Bone-In Wings $.89 each\nTossed To Order','Boneless Bites $.99 each\nHand Breaded']);
  assert.deepEqual(sauces(f),['Buffalo','Ranch']);
  const saved=f.sql("SELECT title,schedule FROM special_collections WHERE id='wing-wednesday'")[0];
  assert.deepEqual({...saved},{title:'Wing Night Special',schedule:'Wednesdays 5–9 PM'});
});
test('reordered items each receive their own wing type\'s price',async t=>{
  const f=await wingWeek(t);
  const live=await store.readCollection(f.env,'wing-wednesday');
  const group=live.groups.find(g=>g.id===OPTIONS);
  group.slots[0].content='Boneless Wings\nHand breaded';group.slots[1].content='Bone In Wings\nSmoked';
  await store.saveCollection(f.env,live);
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Boneless Wings $.99 each\nHand Breaded','Bone In Wings $.89 each\nSmoked']);
  assert.equal(decisions(f)[0].outcome,'published');
});
test('a reordered section still holds only the uncertain type, using the right slot',async t=>{
  const f=await wingWeek(t,{candidate:nightPoster('Wing Night Bone-In $.89 each / Boneless each','Wing Night Bone-In $.89 each')});
  await editOption(f,1,'Boneless Wings');await editOption(f,2,'Bone-In Wings');
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Boneless Wings','Bone-In Wings $.89 each']);
  assert.equal((await readWingAttention(f.env)).unresolved_mask,1,'the boneless item, now in the first slot');
});
for(const [name,first,second,expected] of [
  ['an item naming no wing type','Traditional Wings','Boneless Wings',['Traditional Wings','Boneless Wings $.99 each']],
  ['an item naming both types','Bone-In or Boneless Wings','Boneless Wings',['Bone-In or Boneless Wings','Boneless Wings $.99 each']],
  ['two items naming one type','Boneless Wings','Boneless Bites',['Boneless Wings','Boneless Bites']],
  ['a price in an unnamed item stays','Traditional Wings $1 each','Boneless Wings',['Traditional Wings $1 each','Boneless Wings $.99 each']],
]) test(`ambiguous wing type is held, never guessed: ${name}`,async t=>{
  const f=await wingWeek(t);
  await editOption(f,1,first);await editOption(f,2,second);
  await f.run();
  assert.deepEqual(options(f).slice(0,2),expected);
  assert.equal(decisions(f)[0].outcome,'held');
  assert.match(decisions(f)[0].detail,new RegExp(WING_HOLD.fit));
  if(!/\$/.test(first)) assert.ok(await readWingAttention(f.env));
});
test('one verified price replaces its option; a staff price on the uncertain option stays, unreviewed',async t=>{
  const f=await wingWeek(t,{candidate:nightPoster('Wing Night Bone-In $.89 each / Boneless each','Wing Night Bone-In $.89 each')});
  await editOption(f,1,'Bone-In Wings $1 each');await editOption(f,2,'Boneless Wings $2 each');
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings $.89 each','Boneless Wings $2 each']);
  assert.equal(source(f),'manual','a staff price is still showing');assert.equal(await readWingAttention(f.env),null);
});
test('a poster with both prices uncertain replaces nothing and invents nothing',async t=>{
  const f=await wingWeek(t,{candidate:nightPoster('Wing Night Bone-In Boneless','Wing Night Bone-In Boneless')});
  await editOption(f,1,'Bone-In Wings $1 each');
  await f.run();
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings $1 each','Boneless Wings']);
  assert.equal(decisions(f)[0].outcome,'held');
});
test('a poster removed before the scan cannot replace a staff price',async t=>{
  const f=await wingWeek(t);
  await editOption(f,1,'Bone-In Wings $1 each');
  f.state.posts=[];
  await f.run();
  assert.equal(options(f)[0],'Bone-In Wings $1 each');assert.equal(decisions(f).length,0);
});
test('a poster from an earlier week cannot replace a staff price',async t=>{
  const f=await wingWeek(t);
  await f.run();
  await editOption(f,1,'Bone-In Wings $1 each');
  f.sql('DELETE FROM wing_wednesday_decisions');
  f.sql("UPDATE special_imports SET fb_created_time='2030-01-02T14:00:00Z'");
  const {imports}=f;
  const result=await reconcileWingWednesday(f.env,{sourceIds:imports().map(i=>i.id),today:'2030-01-09',scanToken:await recordWingScan(f.env,Date.now())});
  assert.equal(result.written,false);assert.equal(options(f)[0],'Bone-In Wings $1 each');
});
test('a staff price and its week end at the rollover: the next week starts price-free',async t=>{
  const f=await wingWeek(t);
  await editOption(f,1,'Bone-In Wings $1 each');
  f.state.now=Date.parse('2030-01-14T01:00:00Z');
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings','Boneless Wings']);assert.equal(slotOf(f,1).manual_locked,0);
});

// ── Legacy recurring Wednesday prices ──
const LEGACY='Wing Night!\n\n$.89 Boneless Wings\n$.99 Bone In Wings\nAdd Fries';
const legacySlot=f=>f.sql("SELECT s.group_id,s.position,s.content FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id='defaults' AND g.day_of_week=3 AND g.service='nightly' AND s.position=1")[0];
const seedLegacy=f=>{const slot=legacySlot(f);f.sql('UPDATE special_slots SET content=? WHERE group_id=? AND position=1',LEGACY,slot.group_id);return slot.group_id;};
const weekSlots=(f,day,service)=>f.sql(`SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id JOIN special_collections c ON c.id=g.collection_id
  JOIN weekly_specials w ON w.id=c.weekly_special_id WHERE w.week_start_date='2030-01-14' AND g.day_of_week=? AND g.service=? ORDER BY s.position`,day,service);
test('the automatic rollover never copies a legacy wing price; the template and other specials are unchanged',async t=>{
  const {f}=sunday(t);const group=seedLegacy(f);
  f.sql("UPDATE special_slots SET content='Chicken Stir Fry $12.99' WHERE group_id=(SELECT id FROM special_groups WHERE collection_id='defaults' AND day_of_week=5 AND service='nightly' LIMIT 1) AND position=1");
  await prepare(f);
  const slot=weekSlots(f,3,'nightly')[0];
  assert.equal(slot.content,'Wing Night!\nBone-In Wings\nBoneless Wings\nAdd Fries');
  assert.deepEqual({origin:slot.origin,locked:slot.manual_locked,auto:slot.last_auto_value},{origin:'manual',locked:0,auto:null},'still replaceable by a poster');
  assert.equal(f.sql('SELECT content FROM special_slots WHERE group_id=? AND position=1',group)[0].content,LEGACY,'no template write');
  assert.equal(weekSlots(f,5,'nightly')[0].content,'Chicken Stir Fry $12.99');
  assert.deepEqual(options(f).slice(0,2),['Bone-In Wings','Boneless Wings']);
});
test('a different priced Wednesday promotion in the template keeps its price on rollover',async t=>{
  const {f}=sunday(t);const slot=legacySlot(f);
  f.sql("UPDATE special_slots SET content='Pizza Night $14' WHERE group_id=? AND position=1",slot.group_id);
  await prepare(f);
  assert.equal(weekSlots(f,3,'nightly')[0].content,'Pizza Night $14');
});
test('the Create new week prefill drops the legacy price, even when saved untouched as a staff week',async t=>{
  const {f}=sunday(t);seedLegacy(f);
  const defaults=await store.readCollection(f.env,'defaults');
  const week=store.newWeekFromDefaults(defaults);
  const wed=week.groups.find(g=>g.day_of_week===3 && g.service==='nightly');
  assert.equal(wed.slots[0].content,'Wing Night!\nBone-In Wings\nBoneless Wings\nAdd Fries');
  assert.equal(wed.slots[0].manual_locked,0);
  await store.saveCollection(f.env,week,{start:'2030-01-14',end:'2030-01-20'});
  assert.doesNotMatch(weekSlots(f,3,'nightly')[0].content,/\$/);
});
test('recurring defaults refuse a new wing price, while an untouched legacy value cannot block other edits',async t=>{
  const {f}=sunday(t);seedLegacy(f);
  const defaults=await store.readCollection(f.env,'defaults');
  const wed=defaults.groups.find(g=>g.day_of_week===3 && g.service==='nightly');
  const monday=defaults.groups.find(g=>g.day_of_week===1 && g.service==='all-day');
  monday.slots[0].content='Staff lunch change';
  await store.saveCollection(f.env,defaults);
  const again=await store.readCollection(f.env,'defaults');
  const typed=again.groups.find(g=>g.id===wed.id);
  typed.slots[0].content='Wing Night!\nBone-In Wings $.75 each\nBoneless Wings $.85 each';
  await assert.rejects(store.saveCollection(f.env,again),/cannot include prices/);
  // A tab still holding the legacy value can't restore it after the correction.
  const corrected=await store.readCollection(f.env,'defaults');
  const open=structuredClone(corrected);
  f.sql("UPDATE special_slots SET content='Wing Night!\nBone-In Wings\nBoneless Wings\nAdd Fries' WHERE group_id=? AND position=1",wed.id);
  open.groups.find(g=>g.id===wed.id).slots[0].content=LEGACY;
  await assert.rejects(store.saveCollection(f.env,open),/cannot include prices/);
});
test('a staff-entered Wednesday price in a saved week is kept: staff values are not defaults',async t=>{
  const f=await wingWeek(t);
  const week=await store.readCollection(f.env,'auto-week');
  const wed=week.groups.find(g=>g.day_of_week===3 && g.service==='nightly');
  wed.slots[0]={...wed.slots[0],content:'Wing Night!\nBone-In Wings $1 each\nBoneless Wings $1.10 each',manual_locked:1,staff_edited:true};
  await store.saveCollection(f.env,week,{start:'2030-01-07',end:'2030-01-13'});
  assert.match(f.slots()[0].content,/\$1 each/);
});
test('a verified poster still publishes to both destinations on a week started from the legacy template',async t=>{
  const f=harness(t,{candidate:nightPoster(),week:false,now:'2030-01-16T15:00:00Z'});
  seedLegacy(f);
  await ensureAutomaticWeek(f.env,{today:'2030-01-13',weekday:0,hour:19});
  assert.doesNotMatch(weekSlots(f,3,'nightly')[0].content,/\$/);
  f.state.posts[0]={...f.state.posts[0],created_time:'2030-01-16T14:00:00Z',updated_time:'2030-01-16T14:00:00Z'};
  await f.run();
  assert.equal(weekSlots(f,3,'nightly')[0].content,'Wing Night!\nBone-In Wings $.89 each\nBoneless Wings $.99 each');
  assert.equal(options(f)[0],'Bone-In Wings $.89 each');
});
test('the editor starts from defaults whenever the live section is an earlier week, not only on Sunday',async t=>{
  const {f}=sunday(t);
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $9 each';
  const defaults=await store.readCollection(f.env,'wing-wednesday-defaults');
  assert.equal(store.wingEditorValues(live,defaults,'2030-01-07',new Date('2030-01-15T18:00:00Z')).groups[0].slots[0].content,'Bone-In Wings','rollover missed; Tuesday');
});

// ── Email alerts ──
function alerts(t,options) {
  let db;t.after(()=>db?.close());
  const f=harness(t,options);
  db=new DatabaseSync(f.path);
  db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT); INSERT OR REPLACE INTO settings VALUES('delivery_display','auto');");
  for(const name of ['0022_delivery_automation.sql','0023_facebook_alert_incidents.sql','0024_facebook_alert_evidence.sql']) db.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
  f.env.DB={prepare(query) {
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
  f.env.SPECIALS_ALERT_MODE='MOCK';
  const sent=[];
  return {...f,db,sent,run:()=>runImportPipeline(f.env,{send:async m=>sent.push(m)}),advance:ms=>f.state.now+=ms,
    send:()=>dispatchVerifiedAlerts(f.env,{send:async m=>sent.push(m)}),
    wing:()=>db.prepare("SELECT * FROM facebook_alert_incidents WHERE scope='wing'").all()};
}
const elapse=async f=>{f.advance(ALERT_GRACE_MS);await f.send();};
test('alert: a published daily special does not hide the Wing Wednesday review; one email with date, reason and links',async t=>{
  const f=alerts(t,{candidate:pizza()});
  await f.run();
  assert.equal(f.slots()[0].content,'Pizza Night 16" Pizza $14');
  assert.equal(f.wing()[0].state,'attention');
  await f.send();assert.equal(f.sent.length,0,'grace period holds it');
  await elapse(f);assert.equal(f.sent.length,1);
  await f.send();await f.run();await elapse(f);assert.equal(f.sent.length,1,'never sent twice');
  const {subject,text}=alertMessage('2030-01-09',f.sent[0].code,{detail:f.sent[0].detail});
  assert.match(subject,/2030-01-09 \(Wing Wednesday\)/);
  assert.match(text,/Wednesday, 2030-01-09/);assert.match(text,/Affected destination: Wing Wednesday section/);
  assert.match(text,new RegExp(WING_HOLD.promotion));
  assert.match(text,/\/admin\/automation\?date=2030-01-09#import-/);assert.match(text,/\/admin\/specials#wing-form/);
  assert.equal(f.state.aiCalls,1);
});
test('alert: the Facebook link appears for a real post ID',async t=>{
  const f=alerts(t,{candidate:pizza()});
  f.state.posts[0].id='111_222';
  await f.run();await elapse(f);
  assert.match(alertMessage('2030-01-09',f.sent[0].code,{detail:f.sent[0].detail}).text,/https:\/\/www\.facebook\.com\/111\/posts\/222/);
});
test('alert: a poster failing both destinations sends one email naming both, not two',async t=>{
  const f=alerts(t,{candidate:nightPoster('Wing Night Bone-In Boneless')});
  await f.run();await elapse(f);
  assert.equal(f.sent.length,1);
  const {text}=alertMessage('2030-01-09',f.sent[0].code,{detail:f.sent[0].detail});
  assert.match(text,/Also affected: Wing Wednesday section/);assert.match(text,new RegExp(WING_HOLD.prices));
  assert.equal(f.wing().filter(r=>r.state==='attention').length,0);
});
test('alert: once the daily email is sent, a later Wing Wednesday failure gets its own',async t=>{
  const f=alerts(t,{candidate:nightPoster('Wing Night Bone-In Boneless')});
  await f.run();await elapse(f);
  assert.equal(f.sent.length,1);
  later(f,'p9',45);
  await f.run();await elapse(f);
  assert.ok(f.sent.some(m=>m.detail?.scope==='wing'));
});
test('alert: no Wednesday poster yet sends nothing',async t=>{
  const f=alerts(t,{candidate:nightPoster()});
  f.state.posts=[];
  await f.run();await elapse(f);
  assert.equal(f.sent.length,0);assert.equal(f.wing().length,0);
});
test('alert: a verified poster publishing everywhere sends nothing',async t=>{
  const f=alerts(t,{candidate:nightPoster()});
  await f.run();await elapse(f);
  assert.equal(f.sent.length,0);assert.equal(f.wing().length,0);
});
test('alert: staff values with no wing poster send nothing',async t=>{
  const f=alerts(t,{candidate:pizza()});
  await ensureAutomaticWeek(f.env,{today:'2030-01-09',weekday:3,hour:9});
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $1.10 each';await store.saveCollection(f.env,live);
  await editOption(f,2,'Boneless Wings $2 each');
  await f.run();await elapse(f);
  assert.equal(f.sent.filter(m=>m.detail?.scope==='wing').length,0);
  assert.equal(f.wing().length,0);
});
test('alert: a staff correction during the grace period stops a stale email',async t=>{
  const f=alerts(t,{candidate:pizza()});
  await f.run();assert.equal(f.wing()[0].state,'attention');
  const live=await store.readCollection(f.env,'wing-wednesday');
  live.groups[0].slots[0].content='Bone-In Wings $1.10 each';await store.saveCollection(f.env,live);
  await editOption(f,2,'Boneless Wings $2 each');
  await elapse(f);
  assert.equal(f.sent.length,0,'the edit fails the send fence');
  await f.run();await elapse(f);
  assert.equal(f.sent.length,0);assert.equal(f.wing()[0].state,'resolved');
});
test('alert: a newer verified poster supersedes the held one before it sends',async t=>{
  const f=alerts(t,{candidate:pizza()});
  await f.run();assert.equal(f.wing()[0].state,'attention');
  later(f,'p2',5);f.state.candidate=nightPoster();
  await f.run();await elapse(f);
  assert.equal(f.sent.filter(m=>m.detail?.scope==='wing').length,0);
  assert.ok(f.wing().every(r=>r.state!=='attention'));
});
test('alert: a dismissed post sends nothing',async t=>{
  const f=alerts(t,{candidate:pizza()});
  await f.run();
  f.sql("UPDATE special_imports SET review_status='dismissed'");
  await f.run();await elapse(f);
  assert.equal(f.sent.length,0);
});
test('alert: a failing Wing Wednesday assessment leaves daily alerts working',async t=>{
  const f=alerts(t,{candidate:nightPoster('Wing Night Bone-In Boneless')});
  f.db.exec('DROP TABLE wing_wednesday_decisions');
  await f.run();await elapse(f);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].detail?.scope,'daily');
  assert.equal(f.wing().length,0);
});
