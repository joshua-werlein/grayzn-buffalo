import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
const s=loadTs('src/lib/specials-store.ts');
test('new weeks copy templates once; saved weeks and deliberate blanks never inherit later changes',async t=>{
  const f=fixture(t); const defaults=await s.readCollection(f.env,'defaults');
  const week=s.newWeekFromDefaults(defaults);
  const lunch=week.groups.find(g=>g.day_of_week===1 && g.service==='lunch');
  assert.equal(lunch.slots[0].content,'');
  const saved=await s.saveCollection(f.env,week,{start:'2030-01-07',end:'2030-01-13'});
  defaults.groups.find(g=>g.day_of_week===1 && g.service==='lunch').slots[0].content='New default';
  await s.saveCollection(f.env,defaults);
  const reread=await s.readWeek(f.env,saved.id);
  assert.equal(reread.collection.groups.find(g=>g.day_of_week===1 && g.service==='lunch').slots[0].content,'');
  assert.equal(f.sql('SELECT count(*) n FROM weekly_special_days')[0].n,42);
  await assert.rejects(()=>s.saveCollection(f.env,s.newWeekFromDefaults(defaults),{start:'2030-01-07',end:'2030-01-13'}),s.SpecialConflict);
  assert.equal(f.sql("SELECT count(*) n FROM weekly_specials WHERE week_start_date='2030-01-07'")[0].n,1);
});
test('manual changes and manual blanks lock only changed slots and preserve automatic baseline',async t=>{
  const f=fixture(t); const id=f.sql("SELECT id FROM special_collections WHERE kind='week' LIMIT 1")[0].id;
  const before=await s.readCollection(f.env,id); const g=before.groups.find(g=>g.service==='nightly' && g.day_of_week===1);
  f.sql("UPDATE special_slots SET content='Imported',origin='automation',manual_locked=0,last_auto_value='baseline' WHERE group_id=? AND position IN (1,2,3)",g.id);
  const next=await s.readCollection(f.env,id); const group=next.groups.find(x=>x.id===g.id);
  group.slots[0].content='Corrected'; group.slots[1].content='';
  const week=f.sql('SELECT * FROM weekly_specials WHERE id=?',next.weekly_special_id)[0];
  await s.saveCollection(f.env,next,{start:week.week_start_date,end:week.week_end_date});
  const slots=f.sql('SELECT * FROM special_slots WHERE group_id=? ORDER BY position',g.id);
  // Slot 0: non-empty ('Corrected') → locked manual entry
  assert.equal(slots[0].origin,'manual'); assert.equal(slots[0].manual_locked,1); assert.equal(slots[0].last_auto_value,'baseline');
  // Slot 1: empty (cleared) → unlocked and eligible for automation; last_auto_value preserved
  assert.equal(slots[1].content,''); assert.equal(slots[1].origin,'legacy'); assert.equal(slots[1].manual_locked,0); assert.equal(slots[1].last_auto_value,'baseline');
  assert.equal(slots[2].origin,'automation'); assert.equal(slots[2].manual_locked,0);
});
test('stale saves and races between read and transactional batch cannot partially change data',async t=>{
  const f=fixture(t); const first=await s.readCollection(f.env,'defaults'); const second=structuredClone(first);
  first.groups[0].slots[0].content='First editor'; await s.saveCollection(f.env,first);
  second.groups[0].slots[0].content='Stale editor'; await assert.rejects(()=>s.saveCollection(f.env,second),s.SpecialConflict);
  const next=await s.readCollection(f.env,'defaults'); next.groups[0].slots[0].content='Race loser';
  const batch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{f.sql("UPDATE special_collections SET revision=revision+1 WHERE id='defaults'"); return batch(statements)};
  await assert.rejects(()=>s.saveCollection(f.env,next),s.SpecialConflict);
  assert.equal((await s.readCollection(f.env,'defaults')).groups[0].slots[0].content,'First editor');
});
test('failed statement rolls back revision and all prior writes in the batch',async t=>{
  const f=fixture(t);const next=await s.readCollection(f.env,'defaults');const revision=next.revision;
  const batch=f.env.DB.batch; f.env.DB.batch=statements=>batch([...statements,{sql:'INSERT INTO table_that_does_not_exist VALUES(1)',args:[]}]);
  next.groups[0].slots[0].content='Must roll back';await assert.rejects(()=>s.saveCollection(f.env,next));
  assert.equal((await s.readCollection(f.env,'defaults')).revision,revision);
});
test('Mexican menu editing is isolated from all saved weeks and defaults',async t=>{
  const f=fixture(t); const before=f.sql("SELECT * FROM special_slots ORDER BY group_id,position");
  const next=await s.readCollection(f.env,'mexican-night'); const group=s.blankGroup(-1); group.label='Staff supplied test group'; group.slots[0].content='Staff supplied test item'; next.groups=[group];
  const result=await s.saveCollection(f.env,next); assert.ok(result.groupIds[group.id]);
  assert.deepEqual(f.sql("SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id<>'mexican-night' ORDER BY s.group_id,s.position"),before);
  assert.equal((await s.readCollection(f.env,'mexican-night')).groups[0].slots[0].content,'Staff supplied test item');
});
test('unchanged repeated saves do not bump revision or rewrite content',async t=>{
  const f=fixture(t);const defaults=await s.readCollection(f.env,'defaults');
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  const result=await s.saveCollection(f.env,defaults);
  assert.equal(result.revision,defaults.revision);
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
});
test('form parsing preserves untouched CRLF bytes and ignores client ownership fields',async t=>{
  const f=fixture(t);const original=await s.readCollection(f.env,'defaults');
  original.groups[0].slots[0].content='Line one\r\nLine two';
  const body=new FormData();body.set('group_count',String(original.groups.length));body.set('revision','0');
  original.groups.forEach((g,i)=>{
    for(const [key,value] of Object.entries({id:g.id,day:g.day_of_week,service:g.service,label:g.label,time:g.service_time})) body.set(`g${i}_${key}`,String(value));
    if(g.enabled) body.set(`g${i}_enabled`,'on');
    g.slots.forEach(slot=>{
      body.set(`g${i}_${slot.position}_content`,(slot.content??'').replaceAll('\r\n','\n'));
    });
  });
  body.set('origin','automation');body.set('manual_locked','0');
  const parsed=s.collectionFromForm(body,original);
  assert.equal(parsed.groups[0].slots[0].content,'Line one\r\nLine two');
  assert.equal(parsed.groups[0].slots[0].origin,'legacy');assert.equal(parsed.groups[0].slots[0].manual_locked,1);
});

// ── Phase 4: import review ────────────────────────────────────────────────────

// Helper: insert a staged import record and return its id.
function insertImport(f, {targetKind='week', targetDay=1, targetService='nightly', targetCollectionId=null, fetchedAt='2030-01-01T00:00:00', candidateJson=null}={}) {
  const id = 'testimport' + Math.random().toString(36).slice(2);
  const groups = candidateJson ?? JSON.stringify([{label:'Monday Nightly',day_of_week:targetDay,service:targetService,items:[{content:'Test Item',price:'$10'}]}]);
  f.sql(
    `INSERT INTO special_imports(id,fb_post_id,fb_created_time,caption,permalink_url,caption_hash,image_source_version,parser_version,model_id,target_kind,target_day,target_service,target_collection_id,classification_reason,candidate_json,validation_result,processing_status,fetched_at)
     VALUES(?,?,?,'Test caption','https://fb.com','aabb','img:x',1,'model-x',?,?,?,?,'Classified',?,'ok','staged',?)`,
    id,id,'2030-01-01T18:00:00',targetKind,targetDay,targetService,targetCollectionId,groups,fetchedAt
  );
  return id;
}

test('applyCandidate applies staged items to target week with manual ownership', async t=>{
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,ws.week_start_date,ws.week_end_date FROM weekly_specials ws LIMIT 1')[0];
  const importId=insertImport(f,{targetKind:'week',targetDay:1,targetService:'nightly'});
  const {weeklySpecialId}=await s.applyCandidate(f.env,importId,weekRow.id,0);
  assert.ok(weeklySpecialId);
  const slots=f.sql("SELECT ss.* FROM special_slots ss JOIN special_groups sg ON sg.id=ss.group_id WHERE sg.collection_id=(SELECT sc.id FROM special_collections sc WHERE sc.weekly_special_id=?) AND sg.day_of_week=1 AND sg.service='nightly' ORDER BY ss.position",weeklySpecialId);
  assert.equal(slots[0].content,'Test Item $10');
  assert.equal(slots[0].origin,'manual');
  assert.equal(slots[0].manual_locked,1);
  const imp=f.sql('SELECT review_status FROM special_imports WHERE id=?',importId)[0];
  assert.equal(imp.review_status,'accepted');
});

test('applyCandidate with override groups writes staff-corrected values with manual ownership', async t=>{
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,ws.week_start_date,ws.week_end_date FROM weekly_specials ws LIMIT 1')[0];
  const importId=insertImport(f);
  const overrides=[{label:'Edited Monday Nightly',day_of_week:1,service:'nightly',items:[{content:'Staff Override',price:'$12'}]}];
  await s.applyCandidate(f.env,importId,weekRow.id,0,overrides);
  const slots=f.sql("SELECT ss.* FROM special_slots ss JOIN special_groups sg ON sg.id=ss.group_id WHERE sg.collection_id=(SELECT sc.id FROM special_collections sc WHERE sc.weekly_special_id=?) AND sg.day_of_week=1 AND sg.service='nightly' ORDER BY ss.position",weekRow.id);
  assert.equal(slots[0].content,'Staff Override $12');
  assert.equal(slots[0].price,'');
  assert.equal(slots[0].origin,'manual');
  assert.equal(slots[0].manual_locked,1);
});

test('applyCandidate throws SpecialConflict when target week was saved after import was staged', async t=>{
  const f=fixture(t);
  const weekRow=f.sql('SELECT id FROM weekly_specials LIMIT 1')[0];
  // Set updated_at to a time after the candidate's fetched_at.
  f.sql("UPDATE weekly_specials SET updated_at='2030-06-01T12:00:00' WHERE id=?",weekRow.id);
  const importId=insertImport(f,{fetchedAt:'2030-01-01T00:00:00'});
  await assert.rejects(()=>s.applyCandidate(f.env,importId,weekRow.id,0),s.SpecialConflict);
  // Import must not have been marked accepted.
  assert.equal(f.sql('SELECT review_status FROM special_imports WHERE id=?',importId)[0].review_status,'pending');
});

test('applyCandidate for section candidate applies to mexican-night collection', async t=>{
  const f=fixture(t);
  const importId=insertImport(f,{targetKind:'section',targetDay:-1,targetService:'custom',targetCollectionId:'mexican-night',
    candidateJson:JSON.stringify([{label:'Taco Tuesday',day_of_week:-1,service:'custom',items:[{content:'Tacos al Pastor',price:'$13'}]}]),
    fetchedAt:'2020-01-01T00:00:00'});
  const before=await s.readCollection(f.env,'mexican-night');
  await s.applyCandidate(f.env,importId,null,before.revision);
  const after=await s.readCollection(f.env,'mexican-night');
  assert.ok(after.groups.some(g=>g.slots.some(slot=>slot.content==='Tacos al Pastor $13')));
  // Populated slots must be manually locked; blank slots are eligible for future automation
  assert.ok(after.groups.every(g=>g.slots.every(slot=>
    (slot.content&&slot.content.trim()) ? (slot.origin==='manual'&&slot.manual_locked===1) : (slot.origin==='legacy'&&slot.manual_locked===0)
  )));
});

test('applyCandidate for section throws SpecialConflict when revision changed since page load', async t=>{
  const f=fixture(t);
  const before=await s.readCollection(f.env,'mexican-night');
  const importId=insertImport(f,{targetKind:'section',targetDay:-1,targetService:'custom',targetCollectionId:'mexican-night',fetchedAt:'2020-01-01T00:00:00'});
  // Bump the revision directly (saveCollection is a no-op when content is unchanged).
  f.sql("UPDATE special_collections SET revision=revision+1 WHERE id='mexican-night'");
  // Now try to accept with the stale revision.
  await assert.rejects(()=>s.applyCandidate(f.env,importId,null,before.revision),s.SpecialConflict);
  assert.equal(f.sql('SELECT review_status FROM special_imports WHERE id=?',importId)[0].review_status,'pending');
});

test('applyCandidate on already-accepted import throws error', async t=>{
  const f=fixture(t);
  const weekRow=f.sql('SELECT id FROM weekly_specials LIMIT 1')[0];
  const importId=insertImport(f);
  await s.applyCandidate(f.env,importId,weekRow.id,0);
  await assert.rejects(()=>s.applyCandidate(f.env,importId,weekRow.id,0),/already been reviewed/);
});

test('recordReviewDecision kept makes no specials content changes', async t=>{
  const f=fixture(t);
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  const importId=insertImport(f);
  await s.recordReviewDecision(f.env,importId,'kept','No changes needed');
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.equal(f.sql('SELECT review_status,review_reason FROM special_imports WHERE id=?',importId)[0].review_status,'kept');
});

test('recordReviewDecision dismissed makes no specials content changes', async t=>{
  const f=fixture(t);
  const before=f.sql('SELECT * FROM special_slots ORDER BY group_id,position');
  const importId=insertImport(f);
  await s.recordReviewDecision(f.env,importId,'dismissed','Not relevant');
  assert.deepEqual(f.sql('SELECT * FROM special_slots ORDER BY group_id,position'),before);
  assert.equal(f.sql('SELECT review_status FROM special_imports WHERE id=?',importId)[0].review_status,'dismissed');
});

test('recordReviewDecision on already-reviewed import throws error', async t=>{
  const f=fixture(t);
  const importId=insertImport(f);
  await s.recordReviewDecision(f.env,importId,'kept');
  await assert.rejects(()=>s.recordReviewDecision(f.env,importId,'dismissed'),/already been reviewed/);
});

test('accepted values are written with manual_locked=1 and cannot be auto-overwritten by future imports', async t=>{
  const f=fixture(t);
  const weekRow=f.sql('SELECT id FROM weekly_specials LIMIT 1')[0];
  const importId=insertImport(f);
  await s.applyCandidate(f.env,importId,weekRow.id,0);
  const slots=f.sql("SELECT ss.manual_locked FROM special_slots ss JOIN special_groups sg ON sg.id=ss.group_id WHERE sg.collection_id=(SELECT id FROM special_collections WHERE weekly_special_id=?) AND sg.day_of_week=1 AND sg.service='nightly' ORDER BY ss.position",weekRow.id);
  assert.ok(slots.every(slot=>slot.manual_locked===1),'All accepted slots must be manual_locked');
});

test('review actions cannot affect a different week via forged form data', async t=>{
  const f=fixture(t);
  const weeks=f.sql('SELECT id FROM weekly_specials ORDER BY week_start_date LIMIT 2');
  assert.ok(weeks.length>=2,'Need at least two weeks for isolation test');
  const targetWeekId=weeks[0].id;
  const otherWeekId=weeks[1].id;
  const importId=insertImport(f);
  // Apply to targetWeek; server reads week ID from the parameter, not candidate.
  await s.applyCandidate(f.env,importId,targetWeekId,0);
  // Verify other week's nightly slot 1 was NOT changed.
  const otherSlots=f.sql("SELECT ss.content FROM special_slots ss JOIN special_groups sg ON sg.id=ss.group_id WHERE sg.collection_id=(SELECT id FROM special_collections WHERE weekly_special_id=?) AND sg.day_of_week=1 AND sg.service='nightly' ORDER BY ss.position",otherWeekId);
  assert.ok(!otherSlots.some(s=>s.content==='Test Item $10'),'Other week must not be affected');
});

test('readImportCandidates returns pending staged records and no already-reviewed records', async t=>{
  const f=fixture(t);
  insertImport(f);
  insertImport(f);
  const dismissed=insertImport(f);
  await s.recordReviewDecision(f.env,dismissed,'dismissed');
  const candidates=await s.readImportCandidates(f.env);
  assert.equal(candidates.length,2);
  assert.ok(candidates.every(c=>c.review_status==='pending'));
});

// ── Blank-defaults semantics ──────────────────────────────────────────────────

test('collectionFromForm: blank textarea in defaults stores null', async t => {
  const f=fixture(t);
  const defaults=await s.readCollection(f.env,'defaults');
  const g=defaults.groups[0]; const p=`g0_`;
  const body=new FormData();
  body.set('group_count','1'); body.set('revision',String(defaults.revision));
  body.set(`${p}id`,g.id); body.set(`${p}day`,String(g.day_of_week));
  body.set(`${p}service`,g.service); body.set(`${p}label`,g.label);
  body.set(`${p}time`,g.service_time); if(g.enabled) body.set(`${p}enabled`,'on');
  // All slots submitted as blank.
  for(const slot of g.slots) body.set(`${p}${slot.position}_content`,'');
  const parsed=s.collectionFromForm(body,{...defaults,groups:[g]});
  assert.ok(parsed.groups[0].slots.every(slot=>slot.content===null),'blank defaults slot must be null');
});

test('collectionFromForm: blank textarea in saved week stores empty string', async t => {
  const f=fixture(t);
  const defaults=await s.readCollection(f.env,'defaults');
  const week=s.newWeekFromDefaults(defaults);
  const g=week.groups[0]; const p=`g0_`;
  const body=new FormData();
  body.set('group_count','1'); body.set('revision','0');
  body.set(`${p}id`,g.id); body.set(`${p}day`,String(g.day_of_week));
  body.set(`${p}service`,g.service); body.set(`${p}label`,g.label);
  body.set(`${p}time`,g.service_time); if(g.enabled) body.set(`${p}enabled`,'on');
  for(const slot of g.slots) body.set(`${p}${slot.position}_content`,'');
  // Use the week collection (kind='week') not defaults.
  const fakeWeek={...defaults,kind:'week',id:'',weekly_special_id:null,revision:0,groups:[g]};
  const parsed=s.collectionFromForm(body,fakeWeek);
  assert.ok(parsed.groups[0].slots.every(slot=>slot.content===''),'blank weekly slot must be empty string');
});

// ── unlockBlankSlots ─────────────────────────────────────────────────────────

test('unlockBlankSlots sets manual_locked=0 and origin=legacy for blank slots only', async t => {
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,sc.id cid,sc.revision FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id LIMIT 1')[0];
  const groupId=f.sql('SELECT id FROM special_groups WHERE collection_id=? LIMIT 1',weekRow.cid)[0].id;
  // Give slot 1 a populated manual value, leave slot 2 blank.
  f.sql("UPDATE special_slots SET content='Has content',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",groupId);
  f.sql("UPDATE special_slots SET content='',origin='manual',manual_locked=1 WHERE group_id=? AND position=2",groupId);

  const result=await s.unlockBlankSlots(f.env,weekRow.id,weekRow.revision);
  assert.equal(result.revision,weekRow.revision+1);

  const slot1=f.sql('SELECT * FROM special_slots WHERE group_id=? AND position=1',groupId)[0];
  const slot2=f.sql('SELECT * FROM special_slots WHERE group_id=? AND position=2',groupId)[0];

  // Populated slot must remain locked.
  assert.equal(slot1.manual_locked,1,'populated slot must stay locked');
  assert.equal(slot1.origin,'manual','populated slot origin must stay manual');
  assert.equal(slot1.content,'Has content');

  // Blank slot must be unlocked with legacy origin.
  assert.equal(slot2.manual_locked,0,'blank slot must be unlocked');
  assert.equal(slot2.origin,'legacy','blank slot origin must be set to legacy');
  assert.equal(slot2.content,'','content must not be changed');
  assert.equal(slot2.last_auto_value,null,'last_auto_value must not be changed');
});

test('unlockBlankSlots throws SpecialConflict on stale revision', async t => {
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,sc.revision FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id LIMIT 1')[0];
  await assert.rejects(
    ()=>s.unlockBlankSlots(f.env,weekRow.id,weekRow.revision-1),
    s.SpecialConflict,
    'stale revision must throw SpecialConflict'
  );
});

test('unlockBlankSlots throws on unknown week id', async t => {
  const f=fixture(t);
  await assert.rejects(()=>s.unlockBlankSlots(f.env,9999999,0),/no longer exists/);
});

test('saveCollection relocks a slot when its content is changed after unlock', async t => {
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,ws.week_start_date,ws.week_end_date,sc.id cid,sc.revision FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id LIMIT 1')[0];
  const groupId=f.sql('SELECT id FROM special_groups WHERE collection_id=? AND service<>\'nightly\' LIMIT 1',weekRow.cid)[0]?.id
    ?? f.sql('SELECT id FROM special_groups WHERE collection_id=? LIMIT 1',weekRow.cid)[0].id;

  // Unlock blank slots — the slot we care about must be blank first.
  f.sql("UPDATE special_slots SET content='',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",groupId);
  const revBefore=f.sql('SELECT revision FROM special_collections WHERE id=?',weekRow.cid)[0].revision;
  await s.unlockBlankSlots(f.env,weekRow.id,revBefore);

  const unlocked=f.sql('SELECT * FROM special_slots WHERE group_id=? AND position=1',groupId)[0];
  assert.equal(unlocked.manual_locked,0,'slot must be unlocked before edit');
  assert.equal(unlocked.origin,'legacy');

  // A bartender now edits the slot and saves: content changes → slot gets re-locked.
  const collection=await s.readWeek(f.env,weekRow.id);
  const group=collection.collection.groups.find(g=>g.id===groupId);
  group.slots.find(s=>s.position===1).content='Edited by staff';
  await s.saveCollection(f.env,collection.collection,{start:weekRow.week_start_date,end:weekRow.week_end_date});

  const relocked=f.sql('SELECT manual_locked,origin FROM special_slots WHERE group_id=? AND position=1',groupId)[0];
  assert.equal(relocked.manual_locked,1,'edited slot must be relocked');
  assert.equal(relocked.origin,'manual','edited slot origin must be manual');
});

test('saveCollection does not relock an unchanged unlocked blank slot', async t => {
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,ws.week_start_date,ws.week_end_date,sc.id cid,sc.revision FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id LIMIT 1')[0];
  const groupId=f.sql('SELECT id FROM special_groups WHERE collection_id=? LIMIT 1',weekRow.cid)[0].id;

  f.sql("UPDATE special_slots SET content='',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",groupId);
  const rev=f.sql('SELECT revision FROM special_collections WHERE id=?',weekRow.cid)[0].revision;
  await s.unlockBlankSlots(f.env,weekRow.id,rev);
  assert.equal(f.sql('SELECT manual_locked FROM special_slots WHERE group_id=? AND position=1',groupId)[0].manual_locked,0);

  // Save a different slot (so the batch is not a no-op) but leave position 1 unchanged.
  const collection=await s.readWeek(f.env,weekRow.id);
  const group=collection.collection.groups.find(g=>g.id===groupId);
  // Change a different position to force a real save.
  const otherSlot=group.slots.find(s=>s.position===2);
  if(otherSlot) otherSlot.content='Touched by test';
  await s.saveCollection(f.env,collection.collection,{start:weekRow.week_start_date,end:weekRow.week_end_date});

  // Position 1 was not changed, so it must still be unlocked.
  const pos1=f.sql('SELECT manual_locked FROM special_slots WHERE group_id=? AND position=1',groupId)[0];
  assert.equal(pos1.manual_locked,0,'unchanged unlocked blank slot must stay unlocked after save');
});

// ── lockBlankSlots + readFbFillState ─────────────────────────────────────────

test('readFbFillState returns off when blank slots are all locked', async t => {
  const f=fixture(t);
  // All blank slots in a freshly-loaded week start as manual/locked from migration.
  const weekRow=f.sql('SELECT ws.id,sc.id cid FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id LIMIT 1')[0];
  f.sql("UPDATE special_slots SET content='',origin='manual',manual_locked=1 WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id=?)",weekRow.cid);
  assert.equal(await s.readFbFillState(f.env,weekRow.cid),'off',
    'OFF state — UI must render "Allow Facebook to fill blank spots" button');
});

test('readFbFillState returns on when blank slots are all eligible', async t => {
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,sc.id cid,sc.revision FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id LIMIT 1')[0];
  f.sql("UPDATE special_slots SET content='',origin='manual',manual_locked=1 WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id=?)",weekRow.cid);
  await s.unlockBlankSlots(f.env,weekRow.id,weekRow.revision);
  assert.equal(await s.readFbFillState(f.env,weekRow.cid),'on',
    'ON state — UI must render "Don\'t allow Facebook to fill blank spots" button');
});

test('readFbFillState returns no-blanks when all slots have content', async t => {
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,sc.id cid FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id LIMIT 1')[0];
  f.sql("UPDATE special_slots SET content='Something',origin='manual',manual_locked=1 WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id=?)",weekRow.cid);
  assert.equal(await s.readFbFillState(f.env,weekRow.cid),'no-blanks');
});

test('readFbFillState returns mixed when some blank slots eligible and some locked', async t => {
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,sc.id cid FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id LIMIT 1')[0];
  const groups=f.sql('SELECT id FROM special_groups WHERE collection_id=?',weekRow.cid);
  // Lock all blank slots first.
  f.sql("UPDATE special_slots SET content='',origin='manual',manual_locked=1 WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id=?)",weekRow.cid);
  // Then unlock one specific slot by hand.
  f.sql("UPDATE special_slots SET origin='legacy',manual_locked=0 WHERE group_id=? AND position=1",groups[0].id);
  assert.equal(await s.readFbFillState(f.env,weekRow.cid),'mixed');
});

test('lockBlankSlots re-locks blank eligible slots and leaves populated slots unchanged', async t => {
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,sc.id cid,sc.revision FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id LIMIT 1')[0];
  const groupId=f.sql('SELECT id FROM special_groups WHERE collection_id=? LIMIT 1',weekRow.cid)[0].id;

  // Give position 1 a populated value; make position 2 blank and unlocked.
  f.sql("UPDATE special_slots SET content='Stay untouched',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",groupId);
  f.sql("UPDATE special_slots SET content='',origin='legacy',manual_locked=0 WHERE group_id=? AND position=2",groupId);

  const revBefore=f.sql('SELECT revision FROM special_collections WHERE id=?',weekRow.cid)[0].revision;
  const result=await s.lockBlankSlots(f.env,weekRow.id,revBefore);
  assert.equal(result.revision,revBefore+1);

  const slot1=f.sql('SELECT * FROM special_slots WHERE group_id=? AND position=1',groupId)[0];
  const slot2=f.sql('SELECT * FROM special_slots WHERE group_id=? AND position=2',groupId)[0];

  assert.equal(slot1.content,'Stay untouched','populated slot content must not change');
  assert.equal(slot1.manual_locked,1,'populated slot must stay locked');
  assert.equal(slot1.origin,'manual','populated slot origin must stay manual');

  assert.equal(slot2.content,'','blank slot content must not change');
  assert.equal(slot2.manual_locked,1,'blank slot must now be locked');
  assert.equal(slot2.origin,'manual','blank slot origin must be set to manual');
  assert.equal(slot2.last_auto_value,null,'last_auto_value must not be changed');
});

test('lockBlankSlots throws SpecialConflict on stale revision', async t => {
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,sc.revision FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id LIMIT 1')[0];
  await assert.rejects(
    ()=>s.lockBlankSlots(f.env,weekRow.id,weekRow.revision-1),
    s.SpecialConflict,
    'stale revision must throw SpecialConflict'
  );
});

test('lockBlankSlots throws on unknown week id', async t => {
  const f=fixture(t);
  await assert.rejects(()=>s.lockBlankSlots(f.env,9999999,0),/no longer exists/);
});

test('lockBlankSlots cannot affect a different week', async t => {
  const f=fixture(t);
  const weeks=f.sql('SELECT ws.id,sc.id cid,sc.revision FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id ORDER BY ws.week_start_date LIMIT 2');
  assert.ok(weeks.length>=2,'need at least two saved weeks for isolation test');
  const [target,other]=weeks;

  // Unlock all blank slots in both weeks.
  f.sql("UPDATE special_slots SET content='',origin='legacy',manual_locked=0 WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id=?)",target.cid);
  f.sql("UPDATE special_slots SET content='',origin='legacy',manual_locked=0 WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id=?)",other.cid);

  // Lock only the target week's blank slots.
  const revNow=f.sql('SELECT revision FROM special_collections WHERE id=?',target.cid)[0].revision;
  await s.lockBlankSlots(f.env,target.id,revNow);

  // The other week's slots must remain unlocked.
  const otherSlots=f.sql('SELECT manual_locked FROM special_slots WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id=?)',other.cid);
  assert.ok(otherSlots.every(sl=>sl.manual_locked===0),'other week slots must remain unlocked');
});

test('readFbFillState returns off after lockBlankSlots and on after unlockBlankSlots round-trip', async t => {
  const f=fixture(t);
  const weekRow=f.sql('SELECT ws.id,sc.id cid,sc.revision FROM weekly_specials ws JOIN special_collections sc ON sc.weekly_special_id=ws.id LIMIT 1')[0];
  f.sql("UPDATE special_slots SET content='',origin='manual',manual_locked=1 WHERE group_id IN (SELECT id FROM special_groups WHERE collection_id=?)",weekRow.cid);

  assert.equal(await s.readFbFillState(f.env,weekRow.cid),'off');

  const rev1=f.sql('SELECT revision FROM special_collections WHERE id=?',weekRow.cid)[0].revision;
  await s.unlockBlankSlots(f.env,weekRow.id,rev1);
  assert.equal(await s.readFbFillState(f.env,weekRow.cid),'on');

  const rev2=f.sql('SELECT revision FROM special_collections WHERE id=?',weekRow.cid)[0].revision;
  await s.lockBlankSlots(f.env,weekRow.id,rev2);
  assert.equal(await s.readFbFillState(f.env,weekRow.cid),'off');
});
