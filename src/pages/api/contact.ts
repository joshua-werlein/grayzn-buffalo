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

  let body: Record<string, unknown>;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Bad request' }, 400);
  }

  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim();
  const message = String(body.message ?? '').trim();
  const token = String(body['cf-turnstile-response'] ?? '');

  if (!name || !email || !message) {
    return json(
      { ok: false, error: 'All fields are required.' },
      400,
    );
  }

  if (env.TURNSTILE_SECRET) {
    const verifyResponse = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET,
          response: token,
        }),
      },
    );

    const verify = (await verifyResponse.json()) as {
      success?: boolean;
    };

    if (!verify.success) {
      return json(
        {
          ok: false,
          error: 'Verification failed — please retry.',
        },
        400,
      );
    }
  }

  if (!env.RESEND_API_KEY) {
    return json(
      { ok: false, error: 'Email not configured yet.' },
      500,
    );
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

  const send = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: "Grayz'n Buffalo Website <noreply@grayznbuffalo.com>",
      to: [env.CONTACT_TO_EMAIL ?? 'grayznbar@outlook.com'],
      reply_to: email,
      subject: `Website contact from ${name}`,
      text,
      html,
    }),
  });

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