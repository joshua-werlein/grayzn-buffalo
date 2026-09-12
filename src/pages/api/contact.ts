import type { APIRoute } from 'astro';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any).runtime?.env ?? {};

  const json = (data: object, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  let parsed: unknown;

  try {
    parsed = await request.json();
  } catch {
    return json({ ok: false, error: 'Bad request' }, 400);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ ok: false, error: 'Bad request' }, 400);
  }
  const body = parsed as Record<string, unknown>;
  const field = (key: string) => typeof body[key] === 'string' ? body[key].trim() : '';
  const name = field('name');
  const email = field('email');
  const message = field('message');
  const token = field('cf-turnstile-response');
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!name || !email || !message) {
    return json({ ok: false, error: 'All fields are required.' }, 400);
  }
  if (name.length > 100 || email.length > 254 || message.length > 5000) {
    return json({ ok: false, error: 'Use at most 100 characters for your name, 254 for email, and 5,000 for your message.' }, 400);
  }
  if (!emailPattern.test(email)) {
    return json({ ok: false, error: 'Enter a valid email address.' }, 400);
  }

  // Required in every environment: a missing setting must never bypass
  // verification or silently deliver messages to a fallback recipient.
  const configured = (key: string) => typeof env[key] === 'string' ? env[key].trim() : '';
  const secret = configured('TURNSTILE_SECRET');
  const resendKey = configured('RESEND_API_KEY');
  const destination = configured('CONTACT_TO_EMAIL');
  if (!secret || !resendKey || !destination || !emailPattern.test(destination)) {
    return json({ ok: false, error: 'Contact form is unavailable. Please call us.' }, 503);
  }
  if (!token || token.length > 2048) {
    return json({ ok: false, error: 'Verification failed — please retry.' }, 400);
  }
  try {
    const verifyResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(10000),
    });
    if (!verifyResponse.ok) throw new Error('Verification unavailable');
    const verify = await verifyResponse.json() as { success?: boolean } | null;
    if (verify?.success !== true) {
      return json({ ok: false, error: 'Verification failed — please retry.' }, 400);
    }
  } catch {
    return json({ ok: false, error: 'Verification is unavailable. Please retry or call us.' }, 502);
  }

  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeMessage = escapeHtml(message).replace(/\r?\n/g, '<br />');

  const text = [
    'New website contact message',
    '',
    `Name: ${name}`,
    `Email: ${email}`,
    '',
    'Message:',
    message,
    '',
    'Submitted through grayznbuffalo.com',
  ].join('\n');

  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Website contact from ${safeName}</title>
      </head>

      <body style="margin:0;padding:0;background:#f7ead3;color:#241610;font-family:Arial,Helvetica,sans-serif;">
        <table
          role="presentation"
          width="100%"
          cellspacing="0"
          cellpadding="0"
          border="0"
          style="width:100%;background:#f7ead3;"
        >
          <tr>
            <td align="center" style="padding:32px 16px;">
              <table
                role="presentation"
                width="100%"
                cellspacing="0"
                cellpadding="0"
                border="0"
                style="width:100%;max-width:640px;background:#fffdf8;border:1px solid rgba(36,22,16,.12);border-radius:14px;overflow:hidden;"
              >
                <tr>
                  <td style="background:#241610;padding:24px 28px;">
                    <p style="margin:0 0 6px;color:#ffd23f;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">
                      Grayz'n Buffalo Bar &amp; Grill
                    </p>

                    <h1 style="margin:0;color:#f7ead3;font-size:26px;line-height:1.25;">
                      New website message
                    </h1>
                  </td>
                </tr>

                <tr>
                  <td style="padding:28px;">
                    <table
                      role="presentation"
                      width="100%"
                      cellspacing="0"
                      cellpadding="0"
                      border="0"
                      style="width:100%;border-collapse:collapse;"
                    >
                      <tr>
                        <td style="padding:0 0 8px;color:#6b5a51;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">
                          Name
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:0 0 22px;font-size:18px;font-weight:700;">
                          ${safeName}
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:0 0 8px;color:#6b5a51;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">
                          Email
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:0 0 22px;font-size:16px;">
                          <a
                            href="mailto:${safeEmail}"
                            style="color:#bf1e33;text-decoration:underline;"
                          >
                            ${safeEmail}
                          </a>
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:0 0 8px;color:#6b5a51;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">
                          Message
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:18px;background:#f7ead3;border-left:4px solid #bf1e33;border-radius:8px;font-size:16px;line-height:1.6;">
                          ${safeMessage}
                        </td>
                      </tr>
                    </table>

                    <table
                      role="presentation"
                      cellspacing="0"
                      cellpadding="0"
                      border="0"
                      style="margin-top:26px;"
                    >
                      <tr>
                        <td
                          align="center"
                          bgcolor="#bf1e33"
                          style="border-radius:8px;"
                        >
                          <a
                            href="mailto:${safeEmail}?subject=${encodeURIComponent(
                              `Re: Website contact from ${name}`,
                            )}"
                            style="display:inline-block;padding:13px 22px;color:#f7ead3;font-size:15px;font-weight:700;text-decoration:none;"
                          >
                            Reply to ${safeName}
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="padding:18px 28px;background:#efdfc2;color:#6b5a51;font-size:12px;line-height:1.5;">
                    Sent through the contact form on grayznbuffalo.com.
                    You can also reply normally in your email app.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  let send: Response;
  try {
    send = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: "Grayz'n Buffalo Website <noreply@grayznbuffalo.com>",
        to: [destination],
        reply_to: email,
        subject: `Website contact from ${name}`,
        text,
        html,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return json({ ok: false, error: 'Could not send right now — please call us.' }, 502);
  }

  if (!send.ok) {
    return json(
      {
        ok: false,
        error: 'Could not send right now — please call us.',
      },
      502,
    );
  }

  return json({ ok: true });
};