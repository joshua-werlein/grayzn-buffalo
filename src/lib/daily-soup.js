// Reserved identity is independent of the editable label and other custom groups.
export const soupGroupId = (collectionId, day) => `soup:${collectionId || 'new'}:${day}`;
export const isSoupGroup = group => Number.isInteger(group.day_of_week)
  && group.day_of_week >= 0 && group.day_of_week <= 6
  && /^soup:.+:[0-6]$/.test(group.id) && group.id.endsWith(`:${group.day_of_week}`);

export function blankSoupGroup(collectionId, day) {
  return {id:soupGroupId(collectionId,day),day_of_week:day,service:'custom',label:'Soup',service_time:'',sort:99,enabled:1,
    slots:[1,2,3,4].map(position=>({position,content:'',price:'',section_link:'',origin:'legacy',manual_locked:0,last_auto_value:null}))};
}

export function withSoupControls(collection) {
  if (collection.kind !== 'week' && !(collection.kind === 'defaults' && collection.id === 'defaults')) return collection;
  const groups=[...collection.groups];
  for (let day=0;day<7;day++) if (!groups.some(g=>g.id===soupGroupId(collection.id,day))) groups.push(blankSoupGroup(collection.id,day));
  return {...collection,groups};
}

export const hasStandaloneSoupLabel = text => /^\s*Soups?\s*:/i.test(text);

export function standaloneSoup(offer) {
  const read=text=>/^\s*Soups?\s*:\s*([^\r\n]+?)\s*$/i.exec(text)?.[1];
  const content=read(offer.content), evidence=read(offer.evidence);
  // Never split an included side from a meal, or accept an empty/generic label.
  const ambiguous=/\b(?:sandwich|burger|with|cup\s+of|side|included|coleslaw|special|available|ask|today|tbd)\b|\bw\s*\/|[<>:;]|\$/i;
  if (!content || !evidence || offer.service_time.trim() || ambiguous.test(content) || ambiguous.test(evidence)
    || !/\p{L}/u.test(content) || /^(?:or|and|soups?|none|no soups?)$/i.test(content) || /(?:^|\b)(?:or|and)\s*$/i.test(content)
    || content.normalize('NFKC').replace(/\s+/g,' ').toLowerCase() !== evidence.normalize('NFKC').replace(/\s+/g,' ').toLowerCase()) return null;
  return content.replace(/\s+/g,' ').trim();
}
