import { defineMiddleware } from 'astro:middleware';

// Report-Only is deliberate. Do not enforce this policy until Astro’s executable inline scripts have been externalized and staging verification is complete.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
  "worker-src 'self'",
  "connect-src 'self' https://cloudflareinsights.com https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com https://www.google.com",
  "form-action 'self'",
].join('; ');

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  const headers = new Headers(response.headers);
  const pathname = context.url.pathname;
  const isProductionHost = ['grayznbuffalo.com', 'www.grayznbuffalo.com'].includes(context.url.hostname);

  // Site-wide security headers.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set(
    'Permissions-Policy',
    'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
  );
  headers.set('X-Frame-Options', 'DENY');
  headers.set(
    'Strict-Transport-Security',
    'max-age=15552000; includeSubDomains',
  );
  headers.set('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY);

  // Prevent admin pages from being cached or indexed.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  // Prevent Astro API endpoints from being indexed.
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  // Preview, staging, and temporary deployment URLs must never compete with the
  // canonical production domain in search results.
  if (!isProductionHost) {
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  if (pathname.startsWith('/img/')) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  if (pathname === '/menu.json') {
    headers.set('Cache-Control', 'public, max-age=300, s-maxage=300');
  }

  if (pathname === '/menu') {
    headers.append('Link', '</menu.json>; rel="alternate"; type="application/json"');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
