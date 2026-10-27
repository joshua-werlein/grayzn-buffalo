// Staff decisions live in the existing transactional import audit. Original AI
// readings and candidates are never rewritten. No identity is inferred from the
// shared-password session.
export const APPROVAL_PREFIX='STAFF_APPROVAL:';
export function approvalEvents(events) {
  return events.flatMap(e=>{
    if(e.event_type!=='review' || !e.detail?.startsWith(APPROVAL_PREFIX)) return [];
    try {
      const a=JSON.parse(e.detail.slice(APPROVAL_PREFIX.length));
      return a.version===1 && Array.isArray(a.rows) ? [a] : [];
    } catch {return [];}
  });
}

// Only an audited decision still matching its protected saved destination may
// resolve an AI warning in the transient planner. Unselected evidence remains
// uncertain and persisted source evidence is unchanged.
export function staffConfirmedCandidate(candidate,approvals,groups,slots) {
  if(!Array.isArray(candidate?.offers)) return candidate;
  const offers=candidate.offers.map(o=>({...o}));
  const confirmed=new Set();
  for(const a of approvals) for(const row of a.rows) {
    if(!Number.isInteger(row.index) || !offers[row.index]) continue;
    const group=groups.find(g=>g.id===row.groupId);
    const slot=slots.find(s=>s.group_id===row.groupId && s.position===row.position);
    if(!group || group.enabled!==1 || !slot || slot.manual_locked!==1 || slot.origin!=='manual'
      || slot.content!==row.content || slot.price || slot.section_link!==row.sectionLink) continue;
    offers[row.index]={...offers[row.index],content:row.content,evidence:row.content,
      service_time:group.service==='custom'?'':group.service,service_evidence:group.service==='custom'?'':group.service,
      uncertainties:[]};
    confirmed.add(row.index);
  }
  return {...candidate,offers,staff_confirmed_indices:[...confirmed]};
}
