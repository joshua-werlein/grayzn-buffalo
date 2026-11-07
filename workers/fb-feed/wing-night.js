// Parse complete labelled amounts; partial tokens and detached prices never qualify.
const amount='\\$\\s*(?:\\d+(?:\\.\\d{2})?|\\.\\d{2})';
const label='(bone[ -]in|boneless)(?:\\s+wings?)?';
// "&" joins the two independently labelled options exactly like "•" does; each
// amount stays bound to its own Bone-In/Boneless label.
const separator='[\\s•/|,;&–—-]*';
const suffix='(\\s+each)?';
const itemAfter=`${label}\\s*(${amount})${suffix}`;
const itemBefore=`(${amount})\\s*${label}${suffix}`;

// Printed as either name. A bone-in or boneless line is a wing offer under any heading,
// so it still needs labelled prices rather than passing as an ordinary nightly special.
export const WING_HEADING=/\bwing\s+(?:night|wednesday)\b/i;
export const isWingOffer=offer=>[offer?.content,offer?.evidence].some(text=>typeof text==='string' && (WING_HEADING.test(text) || /\bbone[\s-]*(?:in|less)\b/i.test(text)));

function parse(text) {
  if (typeof text!=='string') return null;
  let body=text.normalize('NFKC').replace(/[‐‑]/g,'-').trim();
  if (/[-–—−+]\s*\$/.test(body)) return null;
  const name=/^wing\s+(night|wednesday)\b/i.exec(body);
  if (!name) return null;
  const heading=/^w/i.test(name[1]) ? 'Wing Wednesday!' : 'Wing Night!';
  body=body.replace(/^wing\s+(?:night|wednesday)!?\s*/i,'');
  let fries='';
  const add=/\badd\s+fries(?:\s+(\$\s*(?:\d+(?:\.\d{2})?|\.\d{2})))?\s*$/i.exec(body);
  if (add) { fries=`Add Fries${add[1] ? ` ${add[1].replace(/\s/g,'')}` : ''}`; body=body.slice(0,add.index); }
  for (const [pattern,before] of [[itemAfter,false],[itemBefore,true]]) {
    const match=new RegExp(`^${separator}${pattern}${separator}${pattern}${separator}$`,'i').exec(body);
    if (!match) continue;
    const rows=before ? [[match[2],match[1],match[3]],[match[5],match[4],match[6]]] : [[match[1],match[2],match[3]],[match[4],match[5],match[6]]];
    const prices=new Map(rows.map(([name,price])=>[name.toLowerCase().replace(/[ -]/g,''),price.replace(/\s/g,'')]));
    const units=new Map(rows.map(([name,,unit])=>[name.toLowerCase().replace(/[ -]/g,''),unit ? ' each' : '']));
    if (prices.size!==2 || !prices.has('bonein') || !prices.has('boneless')) return null;
    const friesPrice=add?.[1]?.replace(/\s/g,'') ?? null;
    if ([...prices.values(),...(friesPrice ? [friesPrice] : [])].some(price=>!Number.isSafeInteger(Math.round(Number(price.slice(1))*100)))) return null;
    return {prices,units,fries,friesPrice,heading};
  }
  return null;
}

// Presentation only: stored/validated content does not need its source again.
export function formatWingNight(content,heading) {
  const parsed=parse(content);
  if (!parsed) return null;
  const result=`${heading ?? parsed.heading}\nBone-In Wings ${parsed.prices.get('bonein')}${parsed.units.get('bonein')}\nBoneless Wings ${parsed.prices.get('boneless')}${parsed.units.get('boneless')}${parsed.fries ? `\n${parsed.fries}` : ''}`;
  return result.length<=150 ? result : null;
}

// Publication always requires complete evidence, including any priced add-on.
export function validateWingNight(content,evidence) {
  const parsed=parse(content), proof=parse(evidence);
  if (!parsed || !proof || [...parsed.prices].some(([name,price])=>Number(price.slice(1))!==Number(proof.prices.get(name)?.slice(1))
    || parsed.units.get(name)!==proof.units.get(name)) || !!parsed.fries!==!!proof.fries
    || (parsed.friesPrice===null)!==(proof.friesPrice===null)
    || (parsed.friesPrice!==null && Number(parsed.friesPrice.slice(1))!==Number(proof.friesPrice.slice(1)))) return null;
  // The evidence is the printed poster, so its name is the one published.
  return formatWingNight(content,proof.heading);
}

// Dedicated section only. Accept a missing amount beside a label, but require
// an unambiguous label/amount/unit match in both readings for each price.
export function verifyWingOptions(content,evidence) {
  const read=text=>{
    const full=parse(text);
    if(full) return full;
    if(typeof text!=='string' || text.length>2400) return null;
    const heading=/^wing\s+(?:night|wednesday)\b!?\s*/i;
    const normalized=text.normalize('NFKC').replace(/[‐‑]/g,'-').trim();
    if(!heading.test(normalized) || /[-–—−+]\s*\$/.test(normalized)) return null;
    const body=normalized.replace(heading,'').replace(/\badd\s+fries(?:\s+\$\s*(?:\d+(?:\.\d{2})?|\.\d{2}))?\s*$/i,'');
    const readings=[];
    for(const before of [false,true]) {
      const item=before ? `(?:(${amount})\\s*)?${label}${suffix}` : `${label}(?:\\s*(${amount}))?${suffix}`;
      for(const count of [1,2]) {
        const match=new RegExp(`^${separator}${Array(count).fill(item).join(separator)}${separator}$`,'i').exec(body);
        if(!match) continue;
        const options=new Map();
        for(let index=1;index<match.length;index+=3) {
          const name=match[index+Number(before)].toLowerCase().replace(/[ -]/g,'');
          const price=match[index+Number(!before)]?.replace(/\s/g,'') ?? '';
          if(options.has(name)) {options.clear();break;}
          options.set(name,[price,match[index+2] ? ' each' : '']);
        }
        if(options.size) readings.push(options);
      }
    }
    if(!readings.length) return null;
    const prices=new Map(),units=new Map();
    for(const name of ['bonein','boneless']) {
      const value=readings[0].get(name);
      if(!value?.[0] || !readings.every(r=>r.get(name)?.join('')===value.join(''))) continue;
      if(!Number.isSafeInteger(Math.round(Number(value[0].slice(1))*100))) continue;
      prices.set(name,value[0]);units.set(name,value[1]);
    }
    return {prices,units};
  };
  const actual=read(content),proof=read(evidence);
  return ['bonein','boneless'].map((key,index)=>{
    const price=actual?.prices.get(key),printed=proof?.prices.get(key);
    const unit=actual?.units.get(key);
    return price && printed && Number(price.slice(1))===Number(printed.slice(1)) && unit===proof?.units.get(key)
      ? `${index===0 ? 'Bone-In Wings' : 'Boneless Wings'} ${price}${unit}` : null;
  });
}
