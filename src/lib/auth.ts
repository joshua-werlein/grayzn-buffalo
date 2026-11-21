// Session auth: password from env, session token in KV (24h TTL).
//
// Deliberately NO failure counting in KV. The free tier allows 1,000 writes/day,
// so a bot POSTing wrong passwords at a KV counter would exhaust the quota and
// then SESSIONS.put fails — meaning nobody can log in. Rate limiting lives at
// the edge where blocked requests use no KV quota, and
// Turnstile rejects bots before this file is ever reached.

const TOKEN_RE = /^[0-9a-f]{32}$/;
const SIGNING_KEY_RE = /^[0-9a-f]{64}$/;
const SESSION_TTL = 86400;

/**
 * Constant-time comparison. A plain `!==` short-circuits at the first differing
 * character, so response timing leaks how much of the password was right.
 * Hashing first also fixes the compared length, so timing can't leak it either.
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function sessionConfig(env: any) {
  const password = env?.ADMIN_PASSWORD;
  const secret = env?.ADMIN_SESSION_KEY;
  const kv = env?.SESSIONS;
  if (typeof password !== 'string' || !password ||
      typeof secret !== 'string' || !SIGNING_KEY_RE.test(secret) || !kv) return null;
  return { password, secret, kv };
}

// The independent Worker secret prevents a KV snapshot from exposing a password
// verifier. Including the token also binds each signature to its own session.
async function sessionSignature(secret: string, password: string, token: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, enc.encode(JSON.stringify(['gb-session-v1', token, password])));
  const hex = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  return 'v1:' + hex;
}

export async function isAuthed(cookies: any, env: any): Promise<boolean> {
  const token = cookies.get('gb_session')?.value;
  // Shape check before touching KV. Our tokens are always 32 lowercase hex
  // chars, so a bot spraying junk cookies gets rejected without a read.
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  const config = sessionConfig(env);
  if (!config) return false;
  try {
    const stored = await config.kv.get('session:' + token);
    if (typeof stored !== 'string' || !/^v1:[0-9a-f]{64}$/.test(stored)) return false;
    return await safeEqual(stored, await sessionSignature(config.secret, config.password, token));
  } catch {
    return false;
  }
}

export async function login(password: string, cookies: any, env: any): Promise<boolean> {
  const config = sessionConfig(env);
  if (!config) return false;
  const token = crypto.randomUUID().replaceAll('-', '');
  try {
    if (!(await safeEqual(password, config.password))) return false;
    const signature = await sessionSignature(config.secret, config.password, token);
    await config.kv.put('session:' + token, signature, { expirationTtl: SESSION_TTL });
  } catch {
    return false;
  }
  cookies.set('gb_session', token, {
    path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL,
  });
  return true;
}

export async function logout(cookies: any, env: any) {
  const token = cookies.get('gb_session')?.value;
  if (token && env?.SESSIONS) await env.SESSIONS.delete('session:' + token);
  cookies.delete('gb_session', { path: '/' });
}

/**
 * Verify a Turnstile token against Cloudflare.
 *
 * Fails closed when TURNSTILE_SECRET is unset or verification is unavailable.
 */
export async function verifyTurnstile(token: string, env: any, ip?: string): Promise<boolean> {
  if (!env?.TURNSTILE_SECRET) return false; 
  if (!token) return false;

  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const out: any = await res.json();
    return out?.success === true;
  } catch {
    return false;
  }
}
