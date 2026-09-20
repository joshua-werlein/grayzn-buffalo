/** One listener for page links, reparented feed links, and the lightbox action. */
export function trackFacebookActivation(event: MouseEvent, page: Location = location, send: typeof fetch = fetch): void {
  if (page.protocol !== 'https:' || !['grayznbuffalo.com', 'www.grayznbuffalo.com'].includes(page.hostname) ||
      page.pathname === '/admin' || page.pathname.startsWith('/admin/') ||
      event.defaultPrevented || !event.isTrusted ||
      !((event.type === 'click' && event.button === 0) || (event.type === 'auxclick' && event.button === 1))) return;
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>('a[href]');
  if (!link || link.hasAttribute('download') || link.closest('[data-lightbox-src], [data-lightbox-text]')) return;
  if (!link.matches('.footer-social, .social-cta a, .specials-cta a, .fb-post-link, [data-lightbox-action]')) return;
  try {
    const target = new URL(link.href);
    if (target.protocol !== 'https:' || !(target.hostname === 'facebook.com' || target.hostname.endsWith('.facebook.com'))) return;
    // Catch both immediate errors and rejected promises; never cancel navigation.
    void send('/api/facebook-click', { method: 'POST', keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => {});
  } catch {}
}
