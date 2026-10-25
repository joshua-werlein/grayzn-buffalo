// Opt-in Resend HTTPS transport for failure alerts. No SDK, no configurable
// endpoint and no imports, so the module also loads standalone in workerd tests.
// Only alert-email.js selects it, after the EMAIL/approval gates and
// SPECIALS_ALERT_PROVIDER=RESEND. Nothing here logs, retries or falls back.
export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
export const RESEND_SENDER = 'alerts@grayznbuffalo.com';
// SHA-256 of the single approved recipient. The repository is public, so the
// address itself stays in private Worker configuration (SPECIALS_ALERT_TO).
export const RESEND_RECIPIENT_SHA256 = '242e2dc5653067a11ece14829f6c9f7934f22783299f7270c21b9c5cc5f3ccbb';
// Mirrors ALERT_SEND_TIMEOUT_MS (asserted by tests); the store's own, possibly
// shorter, signal is combined with this cap.
export const RESEND_TIMEOUT_MS = 5_000;

const API_KEY = /^re_[A-Za-z0-9_-]{8,200}$/;
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const NAMESPACE = /^(production|test-[a-z0-9-]{1,48})$/;
const INCIDENT = /^\d{4}-\d{2}-\d{2}:[a-zA-Z0-9_-]{1,100}:[a-z_]{1,40}$/;
const RESEND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))]
    .map(v=>v.toString(16).padStart(2,'0')).join('');
}

// Stable per durable incident (never per HTTP call). Test harnesses use a
// distinct, persisted test-* namespace so they can never collide with production.
export async function resendIdempotencyKey(incidentKey, namespace = 'production') {
  if(typeof incidentKey!=='string' || !INCIDENT.test(incidentKey) || typeof namespace!=='string' || !NAMESPACE.test(namespace)) throw Error('Invalid alert identity');
  return `grayzn-fb-alert-v1-${await sha256(`grayzn-fb-alert/v1\n${namespace}\n${incidentKey}`)}`;
}

// Returns null unless every private setting is present and approved. Callers
// resolve this BEFORE the durable dispatch fence, so misconfiguration can never
// quarantine an incident as uncertain. recipientSha256 is a test seam only;
// environment values cannot change it.
export async function resendConfig(env, {namespace = 'production', recipientSha256 = RESEND_RECIPIENT_SHA256} = {}) {
  const key=env?.ALERT_RESEND_API_KEY,from=env?.SPECIALS_ALERT_FROM,to=env?.SPECIALS_ALERT_TO;
  if(typeof key!=='string' || !API_KEY.test(key) || from!==RESEND_SENDER
    || typeof to!=='string' || !ADDRESS.test(to) || typeof namespace!=='string' || !NAMESPACE.test(namespace)) return null;
  if(await sha256(to)!==recipientSha256) return null;
  return Object.freeze({key,from,to,namespace});
}

// Exactly one POST. Resolves only with an accepted provider ID; every other
// outcome throws a fixed message without the key, request or provider response.
// An abort ends waiting only; it cannot recall an email Resend already accepted.
export async function sendResendEmail(config, {incidentKey, subject, text, signal}, fetchImpl = globalThis.fetch) {
  signal?.throwIfAborted();
  const idempotencyKey=await resendIdempotencyKey(incidentKey,config.namespace);
  const timeout=AbortSignal.timeout(RESEND_TIMEOUT_MS);
  let response;
  try {
    // workerd rejects redirect:'error'; 'manual' plus the 2xx check refuses redirects.
    response=await fetchImpl(RESEND_ENDPOINT,{method:'POST',redirect:'manual',
      signal:signal?AbortSignal.any([signal,timeout]):timeout,
      headers:{'Authorization':`Bearer ${config.key}`,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},
      body:JSON.stringify({from:config.from,to:[config.to],subject,text})});
  } catch {throw Error('Resend request failed');}
  if(!response?.ok) {
    try {await response?.body?.cancel();} catch { /* Nothing from the body is used. */ }
    throw Error(`Resend rejected alert (HTTP ${Number(response?.status)||0})`);
  }
  let id;
  try {id=JSON.parse(await response.text())?.id;} catch {throw Error('Resend acceptance unconfirmed');}
  if(typeof id!=='string' || !RESEND_ID.test(id)) throw Error('Resend acceptance unconfirmed');
  return {provider:'resend',id};
}
