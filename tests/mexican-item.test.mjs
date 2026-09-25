import test from 'node:test';
import assert from 'node:assert/strict';
import {splitMexicanItem,composeMexicanItem} from '../src/lib/mexican-item.js';
import {loadTs} from './load-ts.mjs';
const s=loadTs('src/lib/specials-store.ts');

test('Mexican items split only at the first newline and preserve subsequent breaks',()=>{
  assert.deepEqual(splitMexicanItem('Burrito $10\nBeans\n\nSalsa'),{title:'Burrito $10',description:'Beans\n\nSalsa'});
  assert.deepEqual(splitMexicanItem('Chicken +$1.50'),{title:'Chicken +$1.50',description:''});
  assert.deepEqual(splitMexicanItem('Burrito\r\nBeans\r\nSalsa'),{title:'Burrito',description:'Beans\r\nSalsa'});
  assert.equal(composeMexicanItem('Burrito','Beans\nSalsa'),'Burrito\nBeans\nSalsa');
  assert.equal(composeMexicanItem('Burrito',''),'Burrito');
});

test('admin split fields enforce combined limit server-side and preserve four slots',()=>{
  const group=s.blankGroup(-1);group.label='Entrees';
  const baseline={id:'mexican-night',kind:'section',title:'Mexican Night',schedule:'',revision:0,groups:[group]};
  const form=new FormData();
  for(const [k,v] of Object.entries({group_count:1,revision:0,title:'Mexican Night',g0_id:group.id,g0_day:-1,g0_service:'custom',g0_label:'Entrees',g0_enabled:'on',g0_1_title:'Burrito',g0_1_description:'Beans\nSalsa'})) form.set(k,String(v));
  const read=()=>s.collectionFromForm(form,baseline);
  assert.equal(read().groups[0].slots[0].content,'Burrito\nBeans\nSalsa');
  assert.equal(read().groups[0].slots.length,4);
  form.set('g0_1_description','');assert.equal(read().groups[0].slots[0].content,'Burrito');
  form.set('g0_1_title','T'.repeat(75));form.set('g0_1_description','D'.repeat(74));
  assert.equal(read().groups[0].slots[0].content.length,150);
  form.set('g0_1_description','D'.repeat(75));assert.throws(read,/150/);
  form.set('g0_1_title','');assert.throws(read,/title/);
  form.set('g0_1_description','');assert.equal(read().groups[0].slots[0].content,'');
  form.set('g0_1_title','Title\nnot a title');assert.throws(read,/one line/);
});
