import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any).runtime?.env ?? {};
  const json = (o: object, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }

  const { name, email, message } = body;
  const token = body['cf-turnstile-response'];
  if (!name || !email || !message) return json({ ok: false, error: 'All fields are required.' }, 400);

  // Verify Turnstile
  if (env.TURNSTILE_SECRET) {
    const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token ?? '' }),
    }).then(r => r.json()) as any;
    if (!verify.success) return json({ ok: false, error: 'Verification failed — please retry.' }, 400);
  }

  // Send via Resend
  if (!env.RESEND_API_KEY) return json({ ok: false, error: 'Email not configured yet.' }, 500);
  const send = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Grayz\'n Buffalo Website <noreply@send.grayznbuffalo.com>',
      to: [env.CONTACT_TO_EMAIL ?? 'grayznbar@outlook.com'],
      reply_to: email,
      subject: `Website contact from ${name}`,
      text: `From: ${name} <${email}>\n\n${message}`,
    }),
  });
  if (!send.ok) return json({ ok: false, error: 'Could not send right now — please call us.' }, 502);
  return json({ ok: true });
};
