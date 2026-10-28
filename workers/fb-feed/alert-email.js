import {ALERT_CODES} from './alert-store.js';
import {resendConfig,sendResendEmail} from './alert-resend.js';
import {formatAlertText,alertSubjectSuffix} from './alert-detail.js';

const approved=env=>env.SPECIALS_ALERT_MODE==='EMAIL' && env.SPECIALS_ALERT_EMAIL_APPROVED==='true';

// Plain-text content shared by every provider. No raw source, IDs, URLs from
// evidence, or provider errors enter this payload; the optional diagnostic is
// built from fixed reasons and sanitized values (alert-detail.js).
export function alertMessage(day,code,{detail=null,firstSeenMs=null}={}) {
  if(!Object.hasOwn(ALERT_CODES,code) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('Invalid alert message');
  return {subject:`Grayz'n Buffalo ${detail?.informational?'publication review (staff protection)':'automation needs review'} — ${day}${alertSubjectSuffix(detail)}`,
    text:formatAlertText({day,code,summary:ALERT_CODES[code],detail,firstSeenMs})};
}

// Native structured send_email binding (the default provider). No binding/configuration is installed by
// this code. Only the separately approved EMAIL mode can reach a real transport.
// Any explicit SPECIALS_ALERT_PROVIDER disables it, so it is never a fallback.
export function emailTransport(env) {
  if (!approved(env) || env.SPECIALS_ALERT_PROVIDER!==undefined) return null;
  const address=v=>typeof v==='string' && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v);
  if(!env.ALERT_EMAIL?.send || !address(env.SPECIALS_ALERT_FROM) || !address(env.SPECIALS_ALERT_TO)) return null;
  return async ({day,code,detail,firstSeenMs,signal})=>{
    // Only a preflight cancellation check. The store bounds its own wait and
    // durably quarantines uncertain sends; it never assumes this aborts email.
    signal?.throwIfAborted();
    const result=await env.ALERT_EMAIL.send({from:env.SPECIALS_ALERT_FROM,to:env.SPECIALS_ALERT_TO,...alertMessage(day,code,{detail,firstSeenMs})});
    if(!result?.messageId) throw Error('Email acceptance unconfirmed');
  };
}

// Provider selection, resolved before the durable dispatch fence. An absent
// provider keeps the native binding; RESEND requires its complete approved
// configuration; anything else fails closed. A selected provider never falls
// back to another. fetch/recipientSha256 are test seams, not configuration.
export async function alertTransport(env,{fetch,recipientSha256}={}) {
  if(!approved(env)) return null;
  if(env.SPECIALS_ALERT_PROVIDER===undefined) return emailTransport(env);
  if(env.SPECIALS_ALERT_PROVIDER!=='RESEND') return null;
  try {
    const config=await resendConfig(env,{recipientSha256});
    if(!config) return null;
    return async ({incidentKey,day,code,detail,firstSeenMs,signal})=>{
      signal?.throwIfAborted();
      return sendResendEmail(config,{incidentKey,signal,...alertMessage(day,code,{detail,firstSeenMs})},fetch);
    };
  } catch {return null;}
}
