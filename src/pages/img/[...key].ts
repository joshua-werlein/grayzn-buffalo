import type { APIRoute } from 'astro';

export const prerender = false;

// Only serve keys we generate. Blocks traversal and stops the route
// becoming a general-purpose reader for anything else in the bucket.
const KEY_RE = /^(?:menu\/\d+\/[0-9a-f-]{36}(@600)?\.webp|facebook\/(?:\d{4}-\d{2}-\d{2}\/)?[A-Za-z0-9_-]+\.(?:jpg|png|webp))$/;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = (locals as any).runtime?.env ?? {};
  const key = params.key ?? '';

  if (!KEY_RE.test(key)) return new Response('Not found', { status: 404 });
  if (!env.PHOTOS) return new Response('Photo storage not configured', { status: 503 });

  const obj = await env.PHOTOS.get(key, { onlyIf: request.headers });
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  // The uuid makes every key immutable, so cache hard and forever.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (!headers.has('content-type')) headers.set('content-type', 'image/webp');

  // onlyIf matched the client's If-None-Match: object comes back with no body.
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers });

  return new Response(obj.body, { headers });
};
