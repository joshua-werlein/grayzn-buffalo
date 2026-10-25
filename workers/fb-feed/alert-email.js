import {ALERT_CODES} from './alert-store.js';

// Native structured send_email binding. No binding/configuration is installed by
// this code. Only the separately approved EMAIL mode can reach a real transport.
export function emailTransport(env) {
  if (env.SPECIALS_ALERT_MODE!=='EMAIL' || env.SPECIALS_ALERT_EMAIL_APPROVED!=='true') return null;
  const address=v=>typeof v==='string' && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v);
  if(!env.ALERT_EMAIL?.send || !address(env.SPECIALS_ALERT_FROM) || !address(env.SPECIALS_ALERT_TO)) return null;
  return async ({day,code,signal})=>{
    // Only a preflight cancellation check. The store bounds its own wait and
    // durably quarantines uncertain sends; it never assumes this aborts email.
    signal?.throwIfAborted();
    if(!Object.hasOwn(ALERT_CODES,code) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('Invalid alert message');
    // No raw source, IDs, URLs from evidence, or provider errors enter this payload.
    const result=await env.ALERT_EMAIL.send({from:env.SPECIALS_ALERT_FROM,to:env.SPECIALS_ALERT_TO,
      subject:`Grayz'n Buffalo automation needs review — ${day}`,
      text:`${ALERT_CODES[code]}\nChicago date: ${day}\nReview: https://grayznbuffalo.com/admin`});
    if(!result?.messageId) throw Error('Email acceptance unconfirmed');
  };
}
