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
