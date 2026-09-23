import type { APIRoute } from 'astro';
import { isAuthed } from '../../../lib/auth';

export const prerender = false;

const PRIV_HEADERS = {
  'cache-control': 'private, max-age=3600',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
};
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function contentTypeForKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}

export const GET: APIRoute = async ({ params, locals, cookies }) => {
  const env = (locals as any).runtime?.env ?? {};
  if (!(await isAuthed(cookies, env))) {
    return new Response('Unauthorized', { status: 401, headers: NO_STORE });
  }

  const key = params.key ?? '';
  // Only serve special-imports/ keys; block traversal and general bucket access.
  if (!key.startsWith('special-imports/') || key.includes('..') || key.includes('\0')) {
    return new Response('Not found', { status: 404, headers: NO_STORE });
  }

  if (!env.PHOTOS) {
    return new Response('Photo storage not configured', { status: 503, headers: NO_STORE });
  }

  let obj: any;
  try {
    obj = await env.PHOTOS.get(key);
  } catch {
    return new Response('Photo storage unavailable', { status: 503, headers: NO_STORE });
  }
  if (!obj) return new Response('Not found', { status: 404, headers: NO_STORE });

  const headers = new Headers(PRIV_HEADERS);
  headers.set('content-type', contentTypeForKey(key));

  const body = typeof obj.arrayBuffer === 'function' ? await obj.arrayBuffer() : obj.body;
  return new Response(body, { headers });
};
