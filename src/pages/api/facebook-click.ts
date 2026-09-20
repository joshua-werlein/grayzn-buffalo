import type { APIRoute } from 'astro';
import { incrementFacebookClicks } from '../../lib/db';

export const POST: APIRoute = async ({ request, locals, url }) => {
  const reply = (status: number) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
  if (url.protocol !== 'https:' || !['grayznbuffalo.com', 'www.grayznbuffalo.com'].includes(url.hostname) ||
      request.headers.get('origin') !== url.origin || url.search ||
      (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) return reply(403);
  // Consume any body; a non-empty body means the client tried to submit data.
  if (await request.text().catch(() => '')) return reply(400);
  try {
    await incrementFacebookClicks((locals as any).runtime?.env ?? {});
    return reply(204);
  } catch { return reply(503); }
};

export const ALL: APIRoute = () => new Response(null, {
  status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
});
