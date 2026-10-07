// Meta Page webhook: authenticate, filter, and enqueue a complete-day refresh.
// The payload is only a wake-up signal. It is never used as specials evidence;
// the queue consumer runs the same full Graph scan and pipeline as the cron.
export const WEBHOOK_PATH = '/api/facebook-webhook';
// Meta batches up to 1000 updates; a Page feed batch is far smaller in practice.
export const WEBHOOK_MAX_BYTES = 256 * 1024;
// Debounce: a burst of edits lands in one consumer batch after the poster settles.
export const WEBHOOK_DELAY_SECONDS = 60;
// Engagement on posts also arrives on the feed field but cannot change specials.
const ENGAGEMENT_ITEMS = new Set(['comment', 'reaction', 'like']);
const HEADERS = {'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store'};

const reply = (body, status = 200, extra = {}) =>
  new Response(body, {status, headers: {...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra}});

function triggerMode(env) {
  return ['OFF', 'LOG', 'RUN'].includes(env.WEBHOOK_TRIGGER_MODE) ? env.WEBHOOK_TRIGGER_MODE : 'OFF';
}

// Operational metadata only: never tokens, signatures, payloads or post text.
function log(request, details) {
  console.log('Facebook webhook', {ray: request.headers.get('cf-ray') ?? null, ...details});
}

// Compare digests so neither length nor content leaks through timing.
async function sameSecret(a, b) {
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function verifySubscription(request, env) {
  const params = new URL(request.url).searchParams;
  const challenge = params.get('hub.challenge') ?? '';
  const ok = typeof env.FB_WEBHOOK_VERIFY_TOKEN === 'string' && env.FB_WEBHOOK_VERIFY_TOKEN !== ''
    && params.get('hub.mode') === 'subscribe' && /^[A-Za-z0-9._~-]{1,256}$/.test(challenge)
    && await sameSecret(params.get('hub.verify_token') ?? '', env.FB_WEBHOOK_VERIFY_TOKEN);
  log(request, {method: 'GET', result: ok ? 'verified' : 'rejected'});
  return ok ? reply(challenge) : reply('Forbidden', 403);
}

// crypto.subtle.verify performs a constant-time HMAC comparison.
async function validSignature(header, body, secret) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header ?? '');
  if (!match || typeof secret !== 'string' || !secret) return false;
  const signature = new Uint8Array(match[1].match(/../g).map(byte => parseInt(byte, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, signature, body);
}

async function readBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WEBHOOK_MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

// Count Page feed changes that can create, edit or remove a post.
function relevantChanges(payload, pageId) {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const pageEntries = entries.filter(entry => pageId && String(entry?.id) === String(pageId));
  const changes = pageEntries.flatMap(entry => Array.isArray(entry?.changes) ? entry.changes : []);
  const feed = changes.filter(change => change?.field === 'feed' && !ENGAGEMENT_ITEMS.has(change?.value?.item));
  return {pageMatch: pageEntries.length > 0, feedChanges: feed.length};
}

export async function handleFacebookWebhook(request, env) {
  if (request.method === 'GET') return verifySubscription(request, env);
  if (request.method !== 'POST') return reply('Method not allowed', 405, {Allow: 'GET, POST'});
  const body = await readBody(request);
  if (!body) { log(request, {method: 'POST', result: 'rejected', reason: 'body too large'}); return reply('Payload too large', 413); }
  if (!await validSignature(request.headers.get('x-hub-signature-256'), body, env.FB_APP_SECRET)) {
    log(request, {method: 'POST', result: 'rejected', reason: 'signature'});
    return reply('Unauthorized', 401);
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(body)); }
  catch { log(request, {method: 'POST', result: 'rejected', reason: 'json'}); return reply('Bad request', 400); }
  const mode = triggerMode(env);
  const {pageMatch, feedChanges} = payload?.object === 'page' ? relevantChanges(payload, env.FB_PAGE_ID) : {pageMatch: false, feedChanges: 0};
  if (!feedChanges) { log(request, {method: 'POST', result: 'ignored', mode, pageMatch, feedChanges, queued: false}); return reply('OK'); }
  if (mode !== 'RUN') { log(request, {method: 'POST', result: 'accepted', mode, pageMatch, feedChanges, queued: false}); return reply('OK'); }
  try {
    // No post content is queued: the consumer always rescans the complete current day.
    await env.IMPORT_TRIGGER.send({type: 'facebook-feed-change', receivedAt: new Date(Date.now()).toISOString()},
      {delaySeconds: WEBHOOK_DELAY_SECONDS});
  } catch (error) {
    // Non-2xx makes Meta redeliver; the cron remains the fallback either way.
    log(request, {method: 'POST', result: 'error', mode, pageMatch, feedChanges, queued: false, error: String(error?.name ?? 'Error')});
    return reply('Temporarily unavailable', 503);
  }
  log(request, {method: 'POST', result: 'accepted', mode, pageMatch, feedChanges, queued: true});
  return reply('OK');
}
