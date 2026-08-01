// Session auth: password from env, session token in KV (24h TTL).
//
// Deliberately NO failure counting in KV. The free tier allows 1,000 writes/day,
// so a bot POSTing wrong passwords at a KV counter would exhaust the quota and
// then SESSIONS.put fails — meaning nobody can log in. Rate limiting lives at
// the edge (WAF rule on POST /admin) where blocked requests cost nothing, and
// Turnstile rejects bots before this file is ever reached.

const TOKEN_RE = /^[0-9a-f]{32}$/;

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

export async function isAuthed(cookies: any, env: any): Promise<boolean> {
  const token = cookies.get('gb_session')?.value;
  // Shape check before touching KV. Our tokens are always 32 lowercase hex
  // chars, so a bot spraying junk cookies gets rejected without a read.
  if (!token || !TOKEN_RE.test(token) || !env?.SESSIONS) return false;
  return (await env.SESSIONS.get('session:' + token)) === '1';
}

export async function login(password: string, cookies: any, env: any): Promise<boolean> {
  if (!env?.ADMIN_PASSWORD) return false;
  if (!(await safeEqual(password, env.ADMIN_PASSWORD))) return false;

  const token = crypto.randomUUID().replaceAll('-', '');
  await env.SESSIONS.put('session:' + token, '1', { expirationTtl: 86400 });
  cookies.set('gb_session', token, {
    path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 86400,
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
 *Fails CLOSED when TURNSTILE_SECRET is unset. Callers that need a deliberate
 * bypass should check for the secret themselves and skip the call — see the
 * `turnstileOn` guard in admin/index.astro, which keeps the bypass visible
 * rather than hiding it in here. 
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
    });
    const out: any = await res.json();
    return out?.success === true;
  } catch {
    return false;
  }
}
