import { runtimeEnv } from '../../lib/runtime-env';
import type { APIRoute } from 'astro';
import { incrementFacebookClicks } from '../../lib/db';
import { BodyTooLarge, readBodyBytes } from '../../lib/request-body';

export const POST: APIRoute = async ({ request, locals, url }) => {
  const reply = (status: number) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
  if (url.protocol !== 'https:' || !['grayznbuffalo.com', 'www.grayznbuffalo.com'].includes(url.hostname) ||
      request.headers.get('origin') !== url.origin || url.search ||
      (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) return reply(403);
  // A non-empty body means the client tried to submit data. Never buffer more
  // than a few bytes of it: this endpoint is public.
  try { if ((await readBodyBytes(request, 64)).byteLength) return reply(400); }
  catch (error) { return reply(error instanceof BodyTooLarge ? 413 : 400); }
  try {
    await incrementFacebookClicks(runtimeEnv(locals));
    return reply(204);
  } catch { return reply(503); }
};

export const ALL: APIRoute = () => new Response(null, {
  status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
});
