import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadTs} from './load-ts.mjs';

// A real repository WebP, not bytes that only imitate the expected header.
const image=readFileSync(new URL('../public/logo-ink-600.webp',import.meta.url));
for(const route of ['menu-photo','welcome-photo']) {
  const {POST}=loadTs(`src/pages/api/${route}.ts`);
  function setup({full=image,thumb=image,mime='image/webp',failure}={}) {
    const calls={puts:[],writes:0,deletes:[]};
    const env={SESSIONS:{get:async()=> '1'},PHOTOS:{
      put:async(key,bytes)=>{if(failure==='r2')throw Error('private provider credential marker');calls.puts.push({key,bytes});},
      delete:async key=>{calls.deletes.push(key);},
    },DB:{prepare:()=>({bind(){return this;},first:async()=>({photo_key:'welcome/old.webp'}),
      run:async()=>{if(failure==='d1')throw Error('private database diagnostic marker');calls.writes++;return {meta:{changes:1}};},
    })}};
    const form=new FormData();form.set('id','1');form.set('slot','1');
    for(const [name,bytes]of [['full',full],['thumb',thumb]])form.set(name,new File([bytes],`${name}.webp`,{type:mime}));
    return {calls,form,env,send:()=>POST({request:new Request(`https://grayznbuffalo.com/api/${route}`,{method:'POST',body:form}),cookies:{get:()=>({value:'a'.repeat(32)})},locals:{runtime:{env}}})};
  }
  for(const field of ['full','thumb']) test(`${route}: spoofed or truncated ${field} never reaches R2 or D1 writes`,async()=>{
    const mismatched=Buffer.from(image);mismatched.writeUInt32LE(0,4);
    for(const bytes of [Buffer.from('not an image'),image.subarray(0,12),mismatched]){
      const f=setup({[field]:bytes});assert.equal((await f.send()).status,400);
      assert.equal(f.calls.puts.length,0);assert.equal(f.calls.writes,0);assert.equal(f.calls.deletes.length,0);
    }
  });
  test(`${route}: real WebP variants retain bytes, save pointer, then retire old objects`,async()=>{
    const f=setup();const response=await f.send();assert.equal(response.status,200);
    assert.equal((await response.json()).ok,true);assert.equal(f.calls.puts.length,2);assert.equal(f.calls.writes,1);
    for(const entry of f.calls.puts)assert.deepEqual(Buffer.from(entry.bytes),image);
    assert.equal(f.calls.deletes.length,2);
  });
  for(const failure of ['r2','d1'])test(`${route}: unexpected ${failure} errors are generic and never delete prior photos`,async()=>{
    const f=setup({failure});const response=await f.send();assert.equal(response.status,500);
    assert.deepEqual(await response.json(),{ok:false,error:'Upload failed. Check your connection and try again.'});
    assert.equal(f.calls.deletes.length,0);
  });
  test(`${route}: existing MIME, size and metadata/remove behavior remain protected`,async()=>{
    const wrongMime=setup({mime:'image/png'});assert.equal((await wrongMime.send()).status,400);assert.equal(wrongMime.calls.puts.length,0);
    const oversized=setup({full:new Uint8Array(10*1024*1024+1)});assert.equal((await oversized.send()).status,413);assert.equal(oversized.calls.puts.length,0);
    const remove=setup();remove.form.delete('full');remove.form.delete('thumb');remove.form.set('remove','1');remove.form.set('action','remove');
    assert.equal((await remove.send()).status,200);assert.equal(remove.calls.puts.length,0);assert.equal(remove.calls.writes,1);
    if(route==='welcome-photo'){
      const metadata=setup();metadata.form.delete('full');metadata.form.delete('thumb');metadata.form.set('action','metadata');
      assert.equal((await metadata.send()).status,200);assert.equal(metadata.calls.puts.length,0);assert.equal(metadata.calls.writes,1);
    }
  });
}
