export const REVIEW_CATEGORIES = { food: 'Food', drinks: 'Drinks', bar: 'The Bar' } as const;
export type ReviewCategory = keyof typeof REVIEW_CATEGORIES;
export const REVIEW_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const REVIEW_DESCRIPTION_LIMIT = 180;
export const REVIEW_DISPLAY_NAME_LIMIT = 60;

export const REVIEW_HEADERS = {
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  Vary: 'Cookie',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function reviewPreviewEnabled(url: URL, env: any): boolean {
  if (env.REVIEWS_PREVIEW === 'staff-production') return url.origin === 'https://grayznbuffalo.com';
  return env.REVIEWS_PREVIEW === 'local'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function reviewCategory(value: FormDataEntryValue | string | null): value is ReviewCategory {
  return typeof value === 'string' && Object.hasOwn(REVIEW_CATEGORIES, value);
}

export function reviewDescription(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const description = value.trim();
  return description.length > 0 && description.length <= REVIEW_DESCRIPTION_LIMIT ? description : null;
}

/** null means Anonymous, undefined means invalid input. */
export function reviewDisplayName(value: FormDataEntryValue | null): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > REVIEW_DISPLAY_NAME_LIMIT || /[\p{C}<>&]/u.test(value)) return;
  return value.trim().normalize('NFC') || null;
}

export const reviewResponse = (message: string, status: number) =>
  new Response(message, { status, headers: REVIEW_HEADERS });

export const reviewImageUrl = (id: string, size: 'small' | 'medium' | 'large') =>
  `/admin/review-image/${id}/${size}`;

export const reviewObjectKey = (id: string, size: 'original' | 'small' | 'medium' | 'large') =>
  `${id}/${size}${size === 'original' ? '' : '.webp'}`;

export function reviewOriginMatches(request: Request, url: URL): boolean {
  return request.headers.get('origin') === url.origin;
}

// Uses the existing session signing secret with a separate purpose and form
// scope. Refreshing sign-in changes the token and invalidates open forms.
export async function reviewCsrf(cookies: any, env: any, scope: 'upload' | 'moderate'): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.ADMIN_SESSION_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(
    JSON.stringify(['gb-reviews-v1', scope, cookies.get('gb_session').value]),
  ));
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function reviewCsrfMatches(
  form: FormData, cookies: any, env: any, scope: 'upload' | 'moderate',
): Promise<boolean> {
  const candidate = form.get('csrf');
  if (typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate)) return false;
  const expected = await reviewCsrf(cookies, env, scope);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
  return difference === 0;
}

export function reviewFormFeedback(request: Request, path: string, code: string, status: number): Response {
  if (request.headers.get('accept')?.includes('application/json')) {
    return Response.json({ code }, { status, headers: REVIEW_HEADERS });
  }
  const location = new URL(path, request.url);
  location.searchParams.set('result', code);
  return new Response(null, { status: 303, headers: { ...REVIEW_HEADERS, Location: location.pathname + location.search + location.hash } });
}
