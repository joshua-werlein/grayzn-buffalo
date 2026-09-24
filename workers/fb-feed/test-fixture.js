import {fixture} from '../../tests/specials-fixture.mjs';
import {runImportPipeline} from './worker.js';
const NOW='2030-01-09T15:00:00Z';
export const offer=(content,evidence='',service_time='')=>({content,evidence,service_time});
export const poster=(day,heading,offers)=>({day_of_week:day,day_evidence:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day],poster_evidence:heading,offers});
export function harness(t, options={}) {
  const f=fixture(t);
  const state={now:Date.parse(options.now ?? NOW),calls:[],aiCalls:0,images:new Map(),
    posts:[{id:'p1',message:options.caption ?? 'Wednesday Night Specials',created_time:'2030-01-09T14:00:00Z',updated_time:'2030-01-09T14:00:00Z',full_picture:'https://cdn.example/photo.jpg'}],
    candidate:options.candidate ?? poster(3,'Wing Night',[offer('Wing Night — Bone-In $.89 each / Boneless $.99 each','Wing Night 5-10 PM')])};
  t.mock.method(Date,'now',()=>state.now);
  t.mock.method(console,'error',()=>{});
  t.mock.method(globalThis,'fetch',async input=>{
    const url=new URL(input);state.calls.push(url);
    if(url.hostname==='graph.facebook.com') return Response.json({data:state.posts});
    return new Response(new Uint8Array([255,216,255]),{headers:{'content-type':'image/jpeg'}});
  });
  const env={...f.env,SPECIALS_IMPORT_MODE:options.mode ?? 'GUARDED_AUTO',FB_PAGE_ID:'test',FB_SYSTEM_TOKEN:'fake',
    AI:{run:async()=>{state.aiCalls++;return {response:JSON.stringify(state.candidate)}}},
    PHOTOS:{put:async(key,data,meta)=>state.images.set(key,{data,meta,uploaded:new Date(state.now)}),
      get:async key=>{const r=state.images.get(key);return r ? {arrayBuffer:async()=>r.data,httpMetadata:r.meta.httpMetadata}:null},
      list:async()=>({objects:[...state.images].map(([key,r])=>({key,uploaded:r.uploaded})),truncated:false}),
      delete:async key=>state.images.delete(key)}};
  if(options.week!==false) {
    f.sql("INSERT INTO weekly_specials(id,week_start_date,week_end_date) VALUES(9000,'2030-01-07','2030-01-13')");
    f.sql("INSERT INTO special_collections(id,kind,weekly_special_id) VALUES('auto-week','week',9000)");
    f.sql("INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled) SELECT 'auto-'||id,'auto-week',day_of_week,service,label,service_time,sort,enabled FROM special_groups WHERE collection_id='defaults'");
    f.sql("INSERT INTO special_slots(group_id,position,content,origin,manual_locked) SELECT g.id,p.position,'','automation',0 FROM special_groups g JOIN special_slots p ON p.group_id=substr(g.id,6) WHERE g.collection_id='auto-week'");
  }
  const slots=(day=3,service='nightly')=>f.sql('SELECT s.* FROM special_slots s JOIN special_groups g ON g.id=s.group_id WHERE g.collection_id=? AND g.day_of_week=? AND g.service=? ORDER BY position','auto-week',day,service);
  return {...f,env,state,slots,run:()=>runImportPipeline(env),imports:()=>f.sql('SELECT * FROM special_imports ORDER BY rowid')};
}

