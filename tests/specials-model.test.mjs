import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';
const s=loadTs('src/lib/specials-store.ts');
const collection=groups=>({id:'test',kind:'week',weekly_special_id:1,title:'',schedule:'',revision:0,groups});
test('zero through four slots render in order, with no empty group or whitespace-only item',()=>{
  for(let count=0;count<=4;count++) {
    const g=s.blankGroup(1);g.label='Nightly';g.slots.forEach((slot,i)=>slot.content=i<count ? `Item ${i+1}` : ' ');
    s.validateCollection(collection([g]));assert.equal(s.visibleSlots(g).length,count);assert.equal(s.visibleGroups([g]).length,count ? 1:0);
  }
});
test('Monday and Friday both support four Nightly items alongside independent Lunch',()=>{
  for(const day of [1,5]) {
    const night=s.blankGroup(day),lunch=s.blankGroup(day);night.label='Nightly';lunch.label='Lunch';lunch.slots[0].content='Lunch';
    night.slots.forEach((slot,i)=>slot.content=`Dinner ${i+1}`);s.validateCollection(collection([night,lunch]));
    assert.equal(s.visibleGroups([night,lunch],day).length,2);assert.equal(s.visibleSlots(night).length,4);
  }
});
test('rejects fifth item, invalid positions, overlength assembled price and orphan prices',()=>{
  const g=s.blankGroup(1);g.label='Lunch';g.slots.push({...g.slots[0],position:5});assert.throws(()=>s.validateCollection(collection([g])),/four/);
  g.slots.pop();g.slots[0].content='a'.repeat(146);g.slots[0].price='$10';s.validateCollection(collection([g]));
  g.slots[0].price='$100';assert.throws(()=>s.validateCollection(collection([g])),/150/);
  g.slots[0].content='';assert.throws(()=>s.validateCollection(collection([g])),/requires/);
});
test('defaults retain unavailable NULL versus explicit blank; saved weeks use explicit blanks',()=>{
  const g=s.blankGroup(1);g.slots[0].content=null;const c={...collection([g]),kind:'defaults',weekly_special_id:null};s.validateCollection(c);
  assert.equal(c.groups[0].slots[0].content,null);assert.equal(c.groups[0].slots[1].content,'');
  assert.equal(s.newWeekFromDefaults(c).groups[0].slots[0].content,'');assert.equal(c.groups[0].slots[0].content,null);
});
const blank=(id,postId,fetched,created)=>({id,fb_post_id:postId,fb_created_time:created,fb_updated_time:null,caption:'',permalink_url:'',image_r2_key:null,target_kind:'ambiguous',target_day:null,target_service:null,target_collection_id:null,classification_reason:'',candidate_json:null,validation_result:null,processing_status:'staged',review_status:'pending',fetched_at:fetched});
test('deduplicateCandidatesByPost keeps newest fetched_at per fb_post_id and sorts by fb_created_time DESC',()=>{
  const v6=blank('id-v6','post-1','2026-09-24T10:00:00Z','2026-09-24T14:00:00Z');
  const v7=blank('id-v7','post-1','2026-09-24T11:30:00Z','2026-09-24T14:00:00Z');
  const other=blank('id-other','post-2','2026-09-24T09:00:00Z','2026-09-24T15:00:00Z');
  const result=s.deduplicateCandidatesByPost([v6,v7,other]);
  assert.equal(result.length,2,'superseded v6 is excluded; two unique posts remain');
  assert.equal(result[0].id,'id-other','post-2 has later fb_created_time and sorts first');
  assert.equal(result[1].id,'id-v7','post-1 shows only its newest parser version');
  assert.ok(!result.some(c=>c.id==='id-v6'),'parser-6 candidate hidden behind parser-7');
  const single=s.deduplicateCandidatesByPost([v6]);
  assert.equal(single[0].id,'id-v6','single candidate with no newer version is kept');
});
