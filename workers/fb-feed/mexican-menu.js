import {splitMexicanItem, composeMexicanItem, normalizeMexicanPrices} from '../../src/lib/mexican-item.js';

export const accessoryGroup = label => /\b(?:add[\s-]*ons?|substitutions?|substitutes?)\b/i.test(label.normalize('NFKC').replace(/[‐‑–—]/g, '-'));
export const promotionalHeading = text => /\bmexican\s+night\b|\btonight\s*@|\bevery\s+tuesday\b/i.test(text);
// Identity excludes only price/size presentation, never dish words or quantities.
export function mexicanItemKey(title) {
  return normalizeMexicanPrices(title).split(/\$|\||[.…‥⋯]/)[0]
    .replace(/\b(?:large|small|medium|mini)\s*$/i,'')
    .normalize('NFKC').toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,' ').trim();
}
export function scheduleKey(text) {
  const normalized=String(text).toLowerCase().replace(/[–—]/g,'-').replace(/\s|[·•]/g,'')
    .replace(/^every/,'').replace(/^tuesdays?(?:night)?/,'');
  const match=/^(\d{1,2})(?::00)?(am|pm)?-(\d{1,2})(?::00)?(am|pm)$/.exec(normalized);
  return match ? `${match[1]}${match[2]||match[4]}-${match[3]}${match[4]}` : null;
}

// Incoming entries are patches. Omission never means deletion, including within
// an accessory group. Ambiguous identities stop the whole collection write.
export function mergeMexicanMenu(incoming, baseline) {
  const previous=new Map();
  for(const group of baseline) for(const item of group.items) {
    const key=mexicanItemKey(item.title);
    if(previous.has(key)) throw Error('Ambiguous recurring Mexican Night item');
    previous.set(key,item);
  }
  const seen=new Set();
  const result=incoming.map(group=>({...group,items:group.items.map(item=>{
    const key=mexicanItemKey(item.title);
    if(!key || seen.has(key)) throw Error('Duplicate Mexican Night item');
    seen.add(key);
    const old=previous.get(key);
    let title=item.title;
    if(old && !/\$|\d\s*(?:cents?|¢)\b/i.test(normalizeMexicanPrices(title))) title=old.title;
    const sizes=old?.title.match(/\b(?:large|small|medium|mini)\b/gi) ?? [];
    if(sizes.some(size=>!new RegExp(`\\b${size}\\b`,'i').test(title))) throw Error('Mexican Night size change requires complete labelled choices');
    let description=item.description || old?.description || '';
    // An accessory printed separately must not also survive under its dish.
    if(!item.description && description && incoming.some(g=>accessoryGroup(g.label) && g.items.some(extra=>mexicanItemKey(extra.title)===mexicanItemKey(description)))) description='';
    composeMexicanItem(title,description);
    return {title,description};
  })}));
  for(const group of baseline) {
    const items=group.items.filter(item=>!seen.has(mexicanItemKey(item.title)));
    if(items.length) result.push({...group,items});
  }
  return result;
}

export function storedMexicanGroups(groups,slots) {
  return groups.filter(g=>g.enabled).map(g=>({id:g.id,label:g.label,items:slots.filter(s=>s.group_id===g.id && s.content?.trim()).map(s=>{
    const item=splitMexicanItem(s.content);
    return {...item,title:[item.title,s.price].filter(Boolean).join(' ')};
  })})).filter(g=>g.items.length);
}
