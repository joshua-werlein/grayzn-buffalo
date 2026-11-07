import {readCollection,SpecialConflict} from './specials-store';
import {composeMexicanItem,splitMexicanItem} from './mexican-item.js';
import {WING_OPTIONS_GROUP,splitWingPrice,wingOptionPositions,wingWednesdayVisible,wingWeekFor} from './wing-wednesday.js';
import {readWingAttention,wingAttentionQuery} from '../../workers/fb-feed/wing-review.js';

const option=(value: unknown,label: string)=>{
  const text=typeof value==='string' ? value.trim() : '';
  if(!text || /[\r\n]/.test(text) || !/^\$\s*(?:\d+(?:\.\d{2})?|\.\d{2})(?:\s+each)?$/i.test(splitWingPrice(text).price))
    throw Error(`Enter one line with a price for ${label}.`);
  return text;
};

export async function approveWingImport(env: any,{importId,revision,boneIn,boneless}: {importId: unknown; revision: unknown; boneIn: unknown; boneless: unknown}) {
  const held=await readWingAttention(env);
  if(!held || held.import_id!==importId) throw Error('This post no longer needs Wing Wednesday review. Reload the page.');
  if(held.revision!==revision) throw new SpecialConflict();
  const live=await readCollection(env,'wing-wednesday');
  if(live.revision!==revision) throw new SpecialConflict();
  const group=live.groups.find(g=>g.id===WING_OPTIONS_GROUP);
  if(!group) throw Error('Use the Wing Wednesday editor for this week.');
  const spots=wingOptionPositions(group.slots);
  const entries=[[boneIn,spots.boneIn,'bone-in wings'],[boneless,spots.boneless,'boneless wings']].flatMap(([value,position,label])=>value==null ? [] : [{
    position:position as number,
    content:composeMexicanItem(option(value,label as string),splitMexicanItem(group.slots.find(slot=>slot.position===position)?.content).description),
  }]);
  const mask=entries.reduce((mask,{position})=>mask | (1 << (position-1)),0);
  if(!mask || (mask & held.unresolved_mask)!==mask) throw Error('Choose an unresolved Wing Wednesday price.');
  const now=new Date(Date.now());
  const current=wingWeekFor(now);
  if(held.week_start!==current.weekStart || held.section_service_date!==current.serviceDate
    || !wingWednesdayVisible(held.section_service_date,now)) {
    throw Error('This Wing Wednesday approval has expired. Reload the page.');
  }
  const token=crypto.randomUUID();
  const prepare=(sql: string,...args: unknown[])=>env.DB.prepare(sql).bind(...args);
  const gate="EXISTS(SELECT 1 FROM special_collections WHERE id='wing-wednesday' AND mutation_token=?1)";
  // Recheck the held decision in the transaction, alongside the submitted revision.
  // Approval never reassigns the section's week or service date.
  const results=await env.DB.batch([
    prepare(`UPDATE special_collections SET revision=revision+1,mutation_token=?1,updated_at=CURRENT_TIMESTAMP,section_source='manual'
      WHERE id='wing-wednesday' AND kind='section' AND revision=?2 AND section_week_start=?3 AND section_service_date=?4
      AND EXISTS(SELECT 1 FROM (${wingAttentionQuery}) held WHERE held.import_id=?5 AND held.decision_rowid=?6 AND held.unresolved_mask=?8)
      AND (SELECT count(*) FROM special_slots WHERE group_id=?7 AND position IN (1,2))=2`,
      token,revision,held.week_start,held.section_service_date,importId,held.decision_rowid,WING_OPTIONS_GROUP,held.unresolved_mask),
    ...entries.map(({content,position})=>prepare(`UPDATE special_slots SET content=?2,price='',origin='manual',manual_locked=1
      WHERE group_id=?3 AND position=?4 AND ${gate}`,token,content,WING_OPTIONS_GROUP,position)),
    prepare(`UPDATE wing_wednesday_decisions SET outcome=?3 WHERE import_id=?2 AND ${gate}`,token,importId,mask===held.unresolved_mask ? 'approved' : 'held'),
    prepare(`SELECT revision FROM special_collections WHERE id='wing-wednesday' AND mutation_token=?1`,token),
  ]);
  const saved=results.at(-1)?.results?.[0];
  if(!saved) throw new SpecialConflict();
  return {revision:saved.revision};
}
