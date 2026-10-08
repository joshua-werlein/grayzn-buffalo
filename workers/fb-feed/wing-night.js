// Parse complete labelled amounts; partial tokens and detached prices never qualify.
const amount='\\$\\s*(?:\\d+(?:\\.\\d{2})?|\\.\\d{2})';
const label='(bone[ -]in|boneless)(?:\\s+wings?)?';
const separator='[\\s•/|,;–—-]*';
const suffix='(\\s+each)?';
const itemAfter=`${label}\\s*(${amount})${suffix}`;
const itemBefore=`(${amount})\\s*${label}${suffix}`;

function parse(text) {
  if (typeof text!=='string') return null;
  let body=text.normalize('NFKC').replace(/[‐‑]/g,'-').trim();
  if (/[-–—−+]\s*\$/.test(body)) return null;
  if (!/^wing\s+night\b/i.test(body)) return null;
  body=body.replace(/^wing\s+night!?\s*/i,'');
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
    return {prices,units,fries,friesPrice};
  }
  return null;
}

// Presentation only: stored/validated content does not need its source again.
export function formatWingNight(content) {
  const parsed=parse(content);
  if (!parsed) return null;
  const result=`Wing Night!\nBone-In Wings ${parsed.prices.get('bonein')}${parsed.units.get('bonein')}\nBoneless Wings ${parsed.prices.get('boneless')}${parsed.units.get('boneless')}${parsed.fries ? `\n${parsed.fries}` : ''}`;
  return result.length<=150 ? result : null;
}

// Publication always requires complete evidence, including any priced add-on.
export function validateWingNight(content,evidence) {
  const parsed=parse(content), proof=parse(evidence);
  if (!parsed || !proof || [...parsed.prices].some(([name,price])=>Number(price.slice(1))!==Number(proof.prices.get(name)?.slice(1))
    || parsed.units.get(name)!==proof.units.get(name)) || !!parsed.fries!==!!proof.fries
    || (parsed.friesPrice===null)!==(proof.friesPrice===null)
    || (parsed.friesPrice!==null && Number(parsed.friesPrice.slice(1))!==Number(proof.friesPrice.slice(1)))) return null;
  return formatWingNight(content);
}
