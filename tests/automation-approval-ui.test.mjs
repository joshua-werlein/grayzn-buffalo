import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {harness} from '../workers/fb-feed/test-fixture.js';
import {loadTs} from './load-ts.mjs';
const {approvalModel,approveImport,isProtectedSlot}=loadTs('src/lib/automation-approval.ts');
const {statusBadge,protectionLabel}=loadTs('src/lib/automation-review.ts');
const {confirmationRows}=loadTs('src/lib/approval-confirmation.ts');
const source=JSON.parse(readFileSync('tests/fixtures/oct27-production.json','utf8'));
const now=new Date('2026-10-27T21:00:00Z'),day='2026-10-27';
const page=(await import('../dist/_worker.js/pages/admin/automation.astro.mjs')).page().default;
const container=await AstroContainer.create();
function setup(t,mexican=false) {
  const raw=mexican?source.mexican:source.daily;
  const f=harness(t,{now:now.toISOString(),candidate:raw});
  f.env.SESSIONS={get:async()=> '1'};
  f.env.SPECIALS_EVIDENCE_VERSION='2';
  f.sql("UPDATE weekly_specials SET week_start_date='2026-10-26',week_end_date='2026-11-01' WHERE id=9000");
  f.sql(`INSERT INTO special_imports(id,fb_post_id,fb_created_time,parser_version,image_r2_key,candidate_json,extracted_json,processing_status,validation_result,validation_reason)
    VALUES('test','post','2026-10-27T15:00:00+0000',19,'test.jpg',?,?,'staged','ok','Uncertain extracted offer')`,mexican?null:JSON.stringify(source.dailyCandidate),JSON.stringify(raw));
  return f;
}
async function dailyInput(f) {
  const m=await approvalModel(f.env,'test',day,now);
  return {m,value:{importId:'test',day,revision:m.collection.revision,evidenceHash:m.evidenceHash,requestId:m.requestId,confirmed:true,
    rows:m.entries.map(e=>({key:e.key,content:e.content,destination:m.destinations.find(d=>d.service===e.suggestedService&&d.position===e.suggestedPosition)?.id}))}};
}
const render=async f=>(await container.renderToResponse(page,{request:new Request('https://grayznbuffalo.com/admin/automation?date='+day,{headers:{cookie:'gb_session='+'a'.repeat(32)}}),locals:{runtime:{env:f.env,now}}})).text();
const visibleConfirms=html=>html.match(/data-protected-confirm(?![^>]*\shidden[\s>])/g)?.length??0;
const staffLock=f=>f.sql("UPDATE special_slots SET content='Staff burger $12',origin='manual',manual_locked=1 WHERE group_id=? AND position=1",f.slots(2,'all-day')[0].group_id);

test('status badges group every import outcome into plain staff labels',()=>{
  assert.equal(statusBadge('Published').label,'Published');
  assert.equal(statusBadge('Failed').label,'Failed');
  assert.equal(statusBadge('Staff Approved').label,'Staff Approved');
  for(const s of ['Held','Partially Published','Partially Staff Approved','Staged — publication unconfirmed']) assert.equal(statusBadge(s).label,'Needs Review',s);
  assert.equal(protectionLabel('Yes — staff locked'),'Protected — edited by staff');
  assert.equal(protectionLabel('No staff lock; other publication safeguards still apply'),'Automation can update');
});

test('confirmation rows show current → new and flag staff edits only when a protected value changes',()=>{
  const base={groupLabel:'All Day',position:1,content:'Burger $10.00',override:false,previous:{content:'Recurring burger $9.00',price:''}};
  const [plain,staff,same,blank]=confirmationRows([base,{...base,override:true},{...base,override:true,previous:{content:'Burger $10.00',price:''}},{...base,override:true,previous:{content:'',price:''}}]);
  assert.deepEqual(plain,{place:'All Day · slot 1',current:'Recurring burger $9.00',next:'Burger $10.00',changed:true,staffEdited:false});
  assert.equal(staff.staffEdited,true);
  assert.equal(same.changed,false);assert.equal(same.staffEdited,false);
  assert.equal(blank.current,'(empty)');assert.equal(blank.staffEdited,false);
});

test('unlocked recurring defaults need no override; the UI hint matches the server rule',async t=>{
  const f=setup(t);const {m,value}=await dailyInput(f);
  const targets=value.rows.map(r=>m.destinations.find(d=>d.id===r.destination));
  assert.ok(targets.every(d=>d && !d.protected));
  for(const g of m.collection.groups) for(const s of g.slots) {
    const d=m.destinations.find(d=>d.id===`${g.id}~${s.position}`);if(d) assert.equal(d.protected,isProtectedSlot(s));
  }
  const html=await render(f);
  assert.equal(visibleConfirms(html),0);
  assert.doesNotMatch(html,/Intentionally replace|Protected replacement explicitly confirmed|No identical saved text/);
  assert.match(html,/Approve &amp; Publish/);
  assert.equal((await approveImport(f.env,value,now)).complete,true);
});

test('a staff-edited destination shows the plain warning and still requires the explicit override server-side',async t=>{
  const f=setup(t);staffLock(f);
  const html=await render(f);
  assert.equal(visibleConfirms(html),1);
  assert.match(html,/This special was edited by staff\. Replace it\?/);
  assert.match(html,/Staff burger \$12/);
  const {value}=await dailyInput(f);value.rows=[value.rows[1]];
  await assert.rejects(()=>approveImport(f.env,value,now,{preview:true}),/protected/);
  value.rows[0].override=true;
  const preview=await approveImport(f.env,value,now,{preview:true});
  const [row]=confirmationRows(preview.audit.rows);
  assert.equal(row.current,'Staff burger $12');assert.equal(row.staffEdited,true);assert.notEqual(row.next,row.current);
});

test('Mexican Night flags only staff-protected items and asks once for the whole menu',async t=>{
  const f=setup(t,true);
  let m=await approvalModel(f.env,'test',day,now);
  const unlocked=!m.menuProtected && m.entries.every(e=>!e.protected);
  const html=await render(f);
  assert.equal(/This menu was edited by staff/.test(html),!unlocked);
  assert.doesNotMatch(html,/Intentionally replace/);
  f.sql("UPDATE special_collections SET section_source='manual' WHERE id='mexican-night'");
  m=await approvalModel(f.env,'test',day,now);assert.equal(m.menuProtected,true);
  assert.match(await render(f),/This menu was edited by staff\. Replace it\?/);
  const value={importId:'test',day,revision:m.collection.revision,evidenceHash:m.evidenceHash,requestId:m.requestId,confirmed:true,
    rows:m.entries.map(e=>({key:e.key,title:e.title,description:e.description,label:e.label}))};
  await assert.rejects(()=>approveImport(f.env,value,now,{preview:true}),/protected/);
  for(const row of value.rows) row.override=true;
  assert.equal((await approveImport(f.env,value,now,{preview:true})).preview,true);
});
