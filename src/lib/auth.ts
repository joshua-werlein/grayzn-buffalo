// Simple session auth: password from env, session token in KV (24h TTL).
export async function isAuthed(cookies: any, env: any): Promise<boolean> {
  const token = cookies.get('gb_session')?.value;
  if (!token || !env?.SESSIONS) return false;
  return (await env.SESSIONS.get('session:' + token)) === '1';
}

export async function login(password: string, cookies: any, env: any): Promise<boolean> {
  if (!env?.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) return false;
  const token = crypto.randomUUID().replaceAll('-', '');
  await env.SESSIONS.put('session:' + token, '1', { expirationTtl: 86400 });
  cookies.set('gb_session', token, { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 86400 });
  return true;
}

export async function logout(cookies: any, env: any) {
  const token = cookies.get('gb_session')?.value;
  if (token && env?.SESSIONS) await env.SESSIONS.delete('session:' + token);
  cookies.delete('gb_session', { path: '/' });
}
