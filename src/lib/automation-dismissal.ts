// Staff dismissal hides a Facebook import from Automation Review. It changes only
// special_imports.review_status (plus an audit event): the import's evidence,
// history and every published special, default and staff edit are untouched.
// 'dismissed' is the existing staff exclusion: automation, recovery and alerts
// already skip it. Restore returns the exact prior review status.
export const DISMISS_PREFIX='STAFF_DISMISS:',RESTORE_PREFIX='STAFF_RESTORE:';
const DISMISSIBLE=['pending','accepted','edited','kept'];
const validId=(id: unknown)=>typeof id==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

export class DismissConflict extends Error {
  constructor() { super('This post was changed by someone else. Reload the page and try again.'); }
}

// Latest staff dismissal audit for an import (its prior review status).
export function lastDismissal(events: any[]): {previous: string}|null {
  for(const e of events) {
    if(e.event_type!=='review' || typeof e.detail!=='string') continue;
    if(e.detail.startsWith(RESTORE_PREFIX)) return null;
    if(!e.detail.startsWith(DISMISS_PREFIX)) continue;
    try { const v=JSON.parse(e.detail.slice(DISMISS_PREFIX.length)); return DISMISSIBLE.includes(v?.previous)?{previous:v.previous}:null; }
    catch { return null; }
  }
  return null;
}

async function apply(env: any,importId: string,from: string,to: string,detail: string,now: Date) {
  const at=now.toISOString();
  // One D1 transaction: the audit row is written only if the compare-and-set
  // status change applies, so a concurrent approval or dismissal wins cleanly.
  const results=await env.DB.batch([
    env.DB.prepare(`INSERT INTO special_import_events(import_id,event_type,detail,occurred_at)
      SELECT ?1,'review',?2,?3 WHERE EXISTS(SELECT 1 FROM special_imports WHERE id=?1 AND review_status=?4)`).bind(importId,detail,at,from),
    env.DB.prepare(`UPDATE special_imports SET review_status=?2,reviewed_at=?3 WHERE id=?1 AND review_status=?4`).bind(importId,to,at,from),
  ]);
  if(!results.at(-1)?.meta?.changes) throw new DismissConflict();
}

export async function dismissImport(env: any,input: any,now=new Date()) {
  if(!input || !validId(input.importId) || !DISMISSIBLE.includes(input.reviewStatus)) throw Error('This post can’t be removed. Reload and try again.');
  const source=await env.DB.prepare('SELECT review_status,processing_status FROM special_imports WHERE id=?1').bind(input.importId).first();
  if(!source) throw Error('This post no longer exists. Reload the page.');
  if(['pending','processing'].includes(source.processing_status)) throw Error('Automation is still working on this post. Try again in a few minutes.');
  if(source.review_status!==input.reviewStatus) throw new DismissConflict();
  await apply(env,input.importId,source.review_status,'dismissed',DISMISS_PREFIX+JSON.stringify({version:1,previous:source.review_status,at:now.toISOString(),identity:'authenticated staff session'}),now);
  return {status:'dismissed'};
}

export async function restoreImport(env: any,input: any,now=new Date()) {
  if(!input || !validId(input.importId)) throw Error('This post can’t be restored. Reload and try again.');
  const source=await env.DB.prepare('SELECT review_status FROM special_imports WHERE id=?1').bind(input.importId).first();
  if(!source) throw Error('This post no longer exists. Reload the page.');
  if(source.review_status!=='dismissed') throw new DismissConflict();
  const {results}=await env.DB.prepare(`SELECT event_type,detail FROM special_import_events WHERE import_id=?1 AND event_type='review'
    AND (detail LIKE 'STAFF_DISMISS:%' OR detail LIKE 'STAFF_RESTORE:%') ORDER BY id DESC LIMIT 1`).bind(input.importId).all();
  // Dismissed elsewhere (no staff audit here) is restored to pending review.
  const previous=lastDismissal(results)?.previous??'pending';
  await apply(env,input.importId,'dismissed',previous,RESTORE_PREFIX+JSON.stringify({version:1,restored:previous,at:now.toISOString(),identity:'authenticated staff session'}),now);
  return {status:previous};
}
