import {chicagoCalendarDate,calendarDayOfWeek,mondayForIsoDate} from './weekly-specials';
import {readCollection,displayedSpecial,specialInputCount,validateCollection,SpecialConflict} from './specials-store';
import {parseReviewEvidence} from './automation-review';
import {normalizeMexicanPrices,composeMexicanItem} from './mexican-item.js';
import {isSoupGroup,standaloneSoup} from './daily-soup.js';
import {validateMexicanNight,validateCurrentDay,canonicalizeSlotContent,reconcilePosterEvidence} from '../../workers/fb-feed/reconcile.js';
import {normalizeMexicanSizeItem,serviceFromEvidence,factKey} from '../../workers/fb-feed/evidence.js';
import {mexicanItemKey,accessoryGroup,scheduleKey} from '../../workers/fb-feed/mexican-menu.js';
import {APPROVAL_PREFIX,approvalEvents} from '../../workers/fb-feed/staff-review.js';

const text=(s: unknown,max: number)=>{
  if(typeof s!=='string' || s.length>max || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(s)
    || /https?:\/\/|\bwww\./i.test(s)) throw Error('Invalid menu text.');
  return s.replace(/\r\n?/g,'\n').trim();
};
function amounts(s: string): string[] {
  s=normalizeMexicanPrices(s);
  const prices=[...s.matchAll(/\$\d+\.\d{2}(?![\d.])/g)].map(m=>m[0]);
  if(s.replace(/\$\d+\.\d{2}(?![\d.])/g,'').includes('$') || /[−-]\s*\$|\$\d+\.\d{2}\s*[-–—/]\s*\d/.test(s)) throw Error('Malformed or ambiguous price.');
  return [...new Set(prices)].sort();
}
function checkPrices(proposed: string,original: string) {
  const p=amounts(proposed),e=amounts(original);
  if(!p.length || JSON.stringify(p)!==JSON.stringify(e)) throw Error('Keep every source price with its item. Verify price corrections in the Specials editor.');
  const pair=/\b(large|small|medium|mini)\s+(\$\d+\.\d{2})/gi;
  const printed=new Set([...normalizeMexicanPrices(original).matchAll(pair)].map(m=>`${m[1].toLowerCase()}:${m[2]}`));
  for(const m of normalizeMexicanPrices(proposed).matchAll(pair)) if(!printed.has(`${m[1].toLowerCase()}:${m[2]}`)) throw Error('Keep each portion label with its printed price.');
}
// Staff edits, legacy values, separate prices/links and values changed after
// automation all require an explicit override. The review UI uses this same
// rule to decide when to ask; approveImport() enforces it.
export const isProtectedSlot=(s: any)=>s.manual_locked===1 || s.origin==='legacy' && !!s.content || s.origin==='automation' && !!s.content && s.content!==s.last_auto_value || !!s.price || !!s.section_link;
async function digest(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
// One page may list 30 imports. Batch its source/audit reads and share collection
// snapshots so review stays below D1's per-request query budget. The POST path
// intentionally builds a fresh model rather than accepting this page cache.
export async function approvalPageContext(env: any,ids: string[],day: string) {
  if(ids.length>30 || ids.some(id=>!/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw Error('Invalid review entries.');
  const encoded=JSON.stringify(ids);
  const query=async(sql: string,...args: any[])=>(await env.DB.prepare(sql).bind(...args).all()).results;
  const [sources,events,weeks]=await Promise.all([
    query(`SELECT i.*,EXISTS(SELECT 1 FROM special_imports n WHERE n.fb_post_id=i.fb_post_id AND n.rowid>i.rowid) approval_superseded
      FROM special_imports i WHERE i.id IN (SELECT value FROM json_each(?1)) ORDER BY i.id LIMIT 30`,encoded),
    query(`SELECT e.import_id,e.event_type,e.detail FROM special_import_events e WHERE e.import_id IN (SELECT value FROM json_each(?1))
      AND e.event_type='review' AND e.detail LIKE 'STAFF_APPROVAL:%'
      AND e.id IN (SELECT h.id FROM special_import_events h WHERE h.import_id=e.import_id AND h.event_type='review'
        AND h.detail LIKE 'STAFF_APPROVAL:%' ORDER BY h.id DESC LIMIT 60) ORDER BY e.id DESC LIMIT 1800`,encoded),
    query(`SELECT w.*,c.id collection_id FROM weekly_specials w JOIN special_collections c ON c.weekly_special_id=w.id AND c.kind='week'
      WHERE w.week_start_date<=?1 AND w.week_end_date>=?1 LIMIT 2`,day),
  ]);
  return {sources:new Map(sources.map((s: any)=>{const {approval_superseded,...row}=s;return [row.id,{row,superseded:!!approval_superseded}];})),
    events,weeks,collections:new Map<string,Promise<any>>()};
}
export async function approvalModel(env: any,importId: string,day: string,now=new Date(),context?: Awaited<ReturnType<typeof approvalPageContext>>) {
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(importId) || day!==chicagoCalendarDate(now)) throw Error('Only today’s imports can be approved here.');
  const cached: any=context?.sources.get(importId);
  const source=context?cached?.row:await env.DB.prepare('SELECT * FROM special_imports WHERE id=?1').bind(importId).first();
  if(!source || !['staged','failed'].includes(source.processing_status) || !['pending','accepted','edited'].includes(source.review_status)) throw Error('This import is not available for approval.');
  const created=new Date(source.fb_created_time);
  if(!Number.isFinite(created.getTime()) || created>now || chicagoCalendarDate(created)!==day || !source.image_r2_key) throw Error('This import does not have current source evidence.');
  if(context?cached.superseded:await env.DB.prepare('SELECT 1 FROM special_imports WHERE fb_post_id=?1 AND rowid>(SELECT rowid FROM special_imports WHERE id=?2) LIMIT 1').bind(source.fb_post_id,source.id).first()) throw Error('A newer reading exists. Reload its review entry.');
  // Prefer original extraction: it retains all uncertainty and portion evidence.
  const raw=parseReviewEvidence(source.extracted_json)??parseReviewEvidence(source.candidate_json);
  if(!raw) throw Error('Usable stored extraction is unavailable.');
  const mexican=raw.type==='mexican-night';
  if(!mexican && !Array.isArray(raw.offers)) throw Error('Use the Specials editor for this import type.');
  const weekday=calendarDayOfWeek(day);
  if(mexican) {
    validateCurrentDay({day_of_week:-1,day_evidence:'',poster_evidence:raw.poster_evidence??''},weekday,day);
    if(weekday!==2) throw Error('Mexican Night approval is available on its Tuesday service date.');
  } else validateCurrentDay(raw,weekday,day);
  let collectionId='mexican-night',week: any=null;
  if(!mexican) {
    const results=context?context.weeks:(await env.DB.prepare(`SELECT w.*,c.id collection_id FROM weekly_specials w JOIN special_collections c ON c.weekly_special_id=w.id AND c.kind='week'
      WHERE w.week_start_date<=?1 AND w.week_end_date>=?1 LIMIT 2`).bind(day).all()).results;
    if(results.length!==1) throw Error('No unique saved week covers today.');
    week=results[0];collectionId=week.collection_id;
  }
  const load=async()=>({collection:await readCollection(env,collectionId),metadata:await env.DB.prepare('SELECT * FROM special_collections WHERE id=?1').bind(collectionId).first()});
  if(context && !context.collections.has(collectionId)) context.collections.set(collectionId,load());
  const {collection,metadata}=await (context?context.collections.get(collectionId)!:load());
  if(!metadata || metadata.revision!==collection.revision) throw new SpecialConflict();
  if(mexican && metadata.section_week_start && metadata.section_week_start>mondayForIsoDate(day)) throw Error('A future Mexican Night menu is already saved. Use its editor.');
  const events=context?context.events.filter((e: any)=>e.import_id===importId):(await env.DB.prepare("SELECT event_type,detail FROM special_import_events WHERE import_id=?1 AND event_type='review' AND detail LIKE 'STAFF_APPROVAL:%' ORDER BY id DESC LIMIT 60").bind(importId).all()).results;
  const approvals=approvalEvents(events);
  const done=new Set(approvals.flatMap((a: any)=>a.rows.map((r: any)=>r.key)));
  let entries: any[]=[];
  if(mexican) {
    if(!Array.isArray(raw.groups)||raw.groups.length<1||raw.groups.length>12) throw Error('Invalid stored menu groups.');
    // Display hint only: approveImport() re-derives protection from the saved slot.
    const saved=collection.groups.flatMap(g=>g.slots.filter(s=>s.content?.trim()).map(s=>({s,key:mexicanItemKey(String(s.content).split('\n')[0])})));
    for(const [g,group] of raw.groups.entries()) {
      if(!Array.isArray(group.items)||group.items.length<1||group.items.length>4) throw Error('Invalid stored menu items.');
      for(const [i,item] of group.items.entries()) {
        const normalized=normalizeMexicanSizeItem(item);
        const original=typeof item.evidence==='string' && item.evidence.trim()?item.evidence:[item.title,item.description].filter(v=>typeof v==='string').join(' ');
        const title=text(normalized.title,300),evidence=typeof item.evidence==='string'?item.evidence:'';
        const matches=saved.filter(v=>[mexicanItemKey(title),mexicanItemKey(evidence)].includes(v.key));
        entries.push({key:`m:${g}:${i}`,group:g,label:text(group.label,80),title,description:text(normalized.description,300),
          original,uncertainties:Array.isArray(item.uncertainties)?item.uncertainties:[],evidence,done:done.has(`m:${g}:${i}`),
          current:matches[0]?displayedSpecial(matches[0].s):'',protected:matches.some(v=>isProtectedSlot(v.s))});
      }
    }
  } else {
    if(raw.offers.length<1||raw.offers.length>48) throw Error('Invalid stored offers.');
    // The planner may suggest a service using the established house layout;
    // uncertain offers remain in position for this suggestion only. Staff must
    // explicitly select the final destination and verify the source.
    let targets: any[]=[];
    try { targets=reconcilePosterEvidence([{...raw,evidence_version:2,offers:raw.offers.map((o: any)=>({...o,uncertainties:[]}))}],weekday,[],{today:day,verifiedSameDaySources:new Set([0])} as any).targets; } catch { /* Explicit selection remains available. */ }
    entries=raw.offers.map((item: any,index: number)=>{
      const content=canonicalizeSlotContent(text(item.content,1200),weekday,serviceFromEvidence(`${item.service_time??''} ${item.service_evidence??''}`));
      const suggestion=targets.flatMap(t=>t.items.map((i: any)=>({...i,service:t.service}))).find(i=>factKey(i.content)===factKey(content));
      return {key:`d:${index}`,index,content,original:typeof item.evidence==='string' && item.evidence.trim()?item.evidence:item.content,
        evidence:typeof item.evidence==='string'?item.evidence:'',uncertainties:Array.isArray(item.uncertainties)?item.uncertainties:[],
        suggestedService:suggestion?.service??serviceFromEvidence(`${item.service_time??''} ${item.service_evidence??''}`),suggestedPosition:suggestion?.position??1,done:done.has(`d:${index}`)};
    });
  }
  if(source.review_status==='edited' && !done.size) throw Error('This import was already reviewed in another editor.');
  const destinations=mexican?[]:collection.groups.filter(g=>g.day_of_week===weekday && g.enabled===1).flatMap(g=>g.slots.filter(s=>s.position<=specialInputCount(g)).map(s=>({
    id:`${g.id}~${s.position}`,groupId:g.id,position:s.position,service:g.service,label:`${g.label} · ${s.position}`,current:displayedSpecial(s),protected:isProtectedSlot(s),
    // Display hint: the same text with no separate price is not a replacement (approveImport() decides).
    content:s.content??'',separatePrice:!!s.price})));
  return {source,raw,mexican,entries,destinations,collection,metadata,week,day,approvals,menuProtected:mexican && metadata.section_source==='manual',
    evidenceHash:await digest([source,collection,metadata,week]),requestId:crypto.randomUUID()};
}

// Deliberately separate from applyCandidate(): existing groups and every
// unselected slot survive. Claim, values and audit are one D1 transaction.
export async function approveImport(env: any,input: any,now=new Date(),{preview=false}={}) {
  // Preview writes nothing. Publishing requires the explicit confirmation sent
  // only by the final Approve & Publish action, after staff saw the preview.
  if(!input || typeof input.importId!=='string' || !/^[0-9a-f-]{36}$/.test(input.requestId??'') || !preview && input.confirmed!==true) throw Error('Confirm the exact proposed replacements and source prices before publishing.');
  const prior=await env.DB.prepare("SELECT detail FROM special_import_events WHERE import_id=?1 AND event_type='review' AND detail LIKE 'STAFF_APPROVAL:%' AND json_extract(substr(detail,16),'$.requestId')=?2 LIMIT 1").bind(input.importId,input.requestId).first();
  if(prior) return {duplicate:true};
  const model=await approvalModel(env,input.importId,input.day,now);
  if(input.evidenceHash!==model.evidenceHash || input.revision!==model.collection.revision) throw new SpecialConflict();
  if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>48) throw Error('Select at least one offer.');
  if(model.mexican && input.rows.length!==model.entries.length) throw Error('Approve the complete Mexican Night menu, including all related entries.');
  const selected=new Set(),destinations=new Set(),rows: any[]=[],newGroups: any[]=[];
  const next=structuredClone(model.collection);
  const baselineItems=model.mexican?next.groups.flatMap(g=>g.slots.filter(s=>s.content?.trim()).map(s=>({g,s,key:mexicanItemKey(String(s.content).split('\n')[0])}))):[];
  if(model.mexican && new Set(baselineItems.map(i=>i.key)).size!==baselineItems.length) throw Error('Existing Mexican menu identities are ambiguous. Use the Specials editor.');
  const menuGroups=new Map<number,any>(),menuIdentities=new Set();
  for(const submitted of input.rows) {
    const entry=model.entries.find(e=>e.key===submitted?.key);
    if(!entry || entry.done || selected.has(entry.key)) throw Error('An offer is invalid, duplicated, or already approved.');
    selected.add(entry.key);
    let group: any,slot: any,content: string;
    if(model.mexican) {
      const title=text(submitted.title,300),description=text(submitted.description,300);
      const key=mexicanItemKey(title);
      if(!key||menuIdentities.has(key)) throw Error('Duplicate Mexican Night menu item.');
      menuIdentities.add(key);
      // Staff may correct wording, but cannot silently turn a source entry into
      // another food or move its printed price to another entry.
      if(![mexicanItemKey(entry.title),mexicanItemKey(entry.evidence)].includes(key)) throw Error('Keep each Mexican item associated with its source heading.');
      content=composeMexicanItem(accessoryGroup(entry.label)?normalizeMexicanPrices(title):title,accessoryGroup(entry.label)?normalizeMexicanPrices(description):description);
      checkPrices(content,entry.original);
      const old=baselineItems.find(i=>i.key===key);
      if(old) {
        if(old.g.enabled!==1) throw Error('This Mexican menu group is hidden. Enable it in the Specials editor before approving.');
        group=old.g;slot=old.s;
      }
      else {
        let extra=newGroups.at(-1);
        if(!extra || extra.label!==entry.label || extra.used===4) {
          extra={id:`mn-staff:${input.requestId}:${newGroups.length}`,day_of_week:-1,service:'custom',label:entry.label,service_time:'',sort:Math.max(-1,...next.groups.map(g=>g.sort))+1,enabled:1,used:0,
            slots:[1,2,3,4].map(position=>({position,content:'',price:'',section_link:'',origin:'legacy',manual_locked:0,last_auto_value:null}))};
          newGroups.push(extra);next.groups.push(extra);
        }
        group=extra;slot=extra.slots[extra.used++];
      }
      const label=text(submitted.label??entry.label,80);
      if(label!==entry.label) throw Error('Keep source menu groups together.');
      const mg=menuGroups.get(entry.group)??{label,items:[]};mg.items.push({title,description});menuGroups.set(entry.group,mg);
    } else {
      const dest=model.destinations.find(d=>d.id===submitted.destination);
      if(!dest) throw Error('Select an established destination for every selected offer.');
      group=next.groups.find(g=>g.id===dest.groupId);slot=group.slots.find((s: any)=>s.position===dest.position);
      content=canonicalizeSlotContent(text(submitted.content,150),calendarDayOfWeek(input.day),group.service);
      if(!content) throw Error('An approved special cannot be blank.');
      if(isSoupGroup(group)) {
        const original=model.raw.offers[entry.index];
        if(!standaloneSoup({content,evidence:original.evidence??original.content,service_time:''})) throw Error('Soup names must match the complete source evidence.');
      } else checkPrices(content,entry.original);
    }
    const destKey=`${group.id}~${slot.position}`;
    if(destinations.has(destKey)) throw Error('Two offers cannot replace the same destination.');
    destinations.add(destKey);
    const protectedSlot=isProtectedSlot(slot);
    const changed=content!==slot.content || !!slot.price;
    if((protectedSlot || model.mexican && model.metadata.section_source==='manual') && changed && submitted.override!==true) throw Error('A special edited by staff (protected) needs confirmation before it can be replaced. Tick “Yes, replace” and review again.');
    rows.push({key:entry.key,index:entry.index??null,groupId:group.id,groupLabel:group.label,position:slot.position,service:group.service,
      content,sectionLink:slot.section_link,previous:{content:slot.content,price:slot.price,section_link:slot.section_link,origin:slot.origin,manual_locked:slot.manual_locked},override:submitted.override===true});
    Object.assign(slot,{content,price:'',origin:'manual',manual_locked:1});
  }
  if(model.mexican) {
    validateMexicanNight({...model.raw,groups:[...menuGroups.values()]});
    if(model.raw.schedule && scheduleKey(model.raw.schedule)!==scheduleKey(model.collection.schedule)) throw Error('Printed schedule differs from the saved Mexican Night schedule. Resolve it in the Specials editor.');
    // The final complete menu (including retained, unadvertised items) must also
    // satisfy menu validation, size and uniqueness rules before any write.
    const finalGroups=next.groups.filter(g=>g.enabled===1).map(g=>({label:g.label,items:g.slots.filter(s=>s.content?.trim()).map(s=>{
      const [title,...description]=String(s.content).split('\n');return {title,description:description.join('\n')};
    })})).filter(g=>g.items.length);
    validateMexicanNight({type:'mexican-night',poster_evidence:'Mexican Night',schedule:next.schedule,groups:finalGroups});
  } else {
    for(const row of rows) if(next.groups.filter(g=>g.day_of_week===calendarDayOfWeek(model.day) && g.enabled===1)
      .some(g=>g.slots.some(s=>!(g.id===row.groupId && s.position===row.position) && s.content && factKey(displayedSpecial(s))===factKey(row.content))))
      throw Error('This offer would appear in two destinations. Keep its existing destination or use the Specials editor to move it.');
  }
  validateCollection(next,model.collection);
  const token=crypto.randomUUID(),collectionId=next.id;
  const complete=model.entries.every(e=>e.done || selected.has(e.key));
  const audit={version:1,requestId:input.requestId,day:model.day,collectionId,revisionBefore:next.revision,revisionAfter:next.revision+1,
    complete,rows,approvedAt:now.toISOString(),identity:'authenticated staff session'};
  if(preview) return {duplicate:false,preview:true,audit};
  const prepare=(sql: string,...args: any[])=>env.DB.prepare(sql).bind(...args);
  const gate='EXISTS(SELECT 1 FROM special_collections WHERE id=?1 AND mutation_token=?2)';
  // Compare the entire server snapshot, including unchanged slots and groups.
  // This also fences out-of-band updates that did not bump a revision.
  const snapshots=[['special_groups','collection_id',model.collection.groups.map(g=>{const {slots,...fields}=g;return fields;})],
    ['special_slots','group_id',model.collection.groups.flatMap(g=>g.slots.map(s=>({...s,group_id:g.id})))]] as const;
  const fence=snapshots.map(([table,,data],i)=>{
    const filter=table==='special_groups'?'t.collection_id=?2':'t.group_id IN (SELECT id FROM special_groups WHERE collection_id=?2)';
    const keys=Object.keys(data[0]??{});
    return `AND (SELECT count(*) FROM ${table} t WHERE ${filter})=json_array_length(?${i+9})
      AND NOT EXISTS(SELECT 1 FROM json_each(?${i+9}) j WHERE NOT EXISTS(SELECT 1 FROM ${table} t WHERE ${filter}
      AND ${keys.map(k=>`t.${k} IS json_extract(j.value,'$.${k}')`).join(' AND ')}))`;
  }).join('\n');
  const writes=[prepare(`UPDATE special_collections SET revision=revision+1,mutation_token=?1
      ${model.mexican?",updated_at=?11,section_source='manual',section_week_start=?12,section_service_date=?5":''}
      WHERE id=?2 AND revision=?3 AND EXISTS(SELECT 1 FROM special_migration_checks WHERE version=15 AND mismatches=0)
      AND EXISTS(SELECT 1 FROM special_imports WHERE id=?4 AND candidate_json IS ?6 AND extracted_json IS ?7 AND review_status=?8
        AND processing_status IN ('staged','failed') AND fb_created_time=?13
        AND NOT EXISTS(SELECT 1 FROM special_imports n WHERE n.fb_post_id=special_imports.fb_post_id AND n.rowid>special_imports.rowid))
      AND ${Object.keys(model.metadata).map(k=>`${k} IS json_extract(?17,'$.${k}')`).join(' AND ')}
      ${model.mexican?'':`AND (SELECT count(*) FROM weekly_specials WHERE week_start_date<=?5 AND week_end_date>=?5)=1
        AND EXISTS(SELECT 1 FROM weekly_specials WHERE id=?14 AND week_start_date=?15 AND week_end_date=?16)`}
      ${fence}`,token,collectionId,next.revision,input.importId,model.day,model.source.candidate_json,model.source.extracted_json,model.source.review_status,
      JSON.stringify(snapshots[0][2]),JSON.stringify(snapshots[1][2]),now.toISOString(),mondayForIsoDate(model.day),model.source.fb_created_time,
      ...(model.mexican?[null,null,null]:[model.week.id,model.week.week_start_date,model.week.week_end_date]),JSON.stringify(model.metadata))];
  for(const group of newGroups) {
    writes.push(prepare(`INSERT INTO special_groups(id,collection_id,day_of_week,service,label,service_time,sort,enabled) SELECT ?3,?1,-1,'custom',?4,'',?5,1 WHERE ${gate}`,collectionId,token,group.id,group.label,group.sort));
    writes.push(prepare(`INSERT INTO special_slots(group_id,position,content,price,section_link,origin,manual_locked,last_auto_value)
      SELECT ?3,value,'','','','legacy',0,NULL FROM json_each('[1,2,3,4]') WHERE ${gate}`,collectionId,token,group.id));
  }
  for(const row of rows) writes.push(prepare(`UPDATE special_slots SET content=?3,price='',origin='manual',manual_locked=1 WHERE group_id=?4 AND position=?5 AND ${gate}`,collectionId,token,row.content,row.groupId,row.position));
  if(!model.mexican) writes.push(prepare(`UPDATE weekly_specials SET updated_at=?3 WHERE id=?4 AND ${gate}`,collectionId,token,now.toISOString(),model.week.id));
  // Accepted preserves the source's independent delivery evidence. Food slots
  // are protected by ownership and the complete approval audit, not dismissal
  // of the entire Facebook source (which could disable confirmed delivery).
  writes.push(prepare(`UPDATE special_imports SET review_status=?3,review_reason='Staff approved selected content; see approval audit',reviewed_at=?4 WHERE id=?5 AND ${gate}`,collectionId,token,complete?'accepted':model.source.review_status,now.toISOString(),input.importId));
  writes.push(prepare(`INSERT INTO special_import_events(import_id,event_type,detail,occurred_at) SELECT ?3,'review',?4,?5 WHERE ${gate}`,collectionId,token,input.importId,APPROVAL_PREFIX+JSON.stringify(audit),now.toISOString()));
  writes.push(prepare('SELECT id FROM special_collections WHERE id=?1 AND mutation_token=?2',collectionId,token));
  const results=await env.DB.batch(writes);
  if(!results.at(-1)?.results?.length) throw new SpecialConflict();
  return {duplicate:false,revision:next.revision+1,complete};
}
