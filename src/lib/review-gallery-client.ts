export function connectReviewGallery() {
  const gallery = document.getElementById('gallery');
  const status = gallery?.querySelector<HTMLElement>('[data-gallery-status]');
  const error = gallery?.querySelector<HTMLElement>('[data-gallery-error]');
  if (!gallery || !status || !error) return;

  let request: AbortController | undefined;
  let renderedSearch = location.search;

  async function navigate(url: URL, mode: 'append' | 'push' | 'restore') {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    error!.hidden = true;
    const current = gallery!.querySelector<HTMLElement>('[data-gallery-results]');
    current?.setAttribute('aria-busy', 'true');
    status!.textContent = 'Loading photos…';
    try {
      const response = await fetch('/admin/review-gallery' + url.search, {
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      if (!response.ok) throw new Error();
      const fragment = document.createElement('template');
      fragment.innerHTML = await response.text();
      if (controller.signal.aborted) return;
      const incoming = fragment.content.querySelector<HTMLElement>('[data-gallery-results]');
      if (!incoming || !current) throw new Error();

      if (mode === 'append') {
        const grid = current.querySelector('ul');
        if (!grid) throw new Error();
        const ids = new Set(Array.from(grid.querySelectorAll<HTMLElement>('[data-photo-id]'), item => item.dataset.photoId));
        const items = Array.from(incoming.querySelectorAll<HTMLElement>('[data-photo-id]')).filter(item => !ids.has(item.dataset.photoId));
        const oldMore = current.querySelector('[data-gallery-more]');
        const next = incoming.querySelector('[data-gallery-more]');
        grid.append(...items);
        if (oldMore && next) oldMore.replaceWith(next);
        else oldMore?.remove();
        const first = items[0]?.querySelector('button') ?? current.querySelector<HTMLElement>('[data-gallery-more]');
        (first ?? document.getElementById('gallery-title'))?.focus();
        status!.textContent = items.length ? items.length + ' more photos loaded.' : 'No additional photos in this batch.';
      } else {
        current.replaceWith(incoming);
        const category = url.searchParams.get('category') ?? '';
        for (const link of gallery!.querySelectorAll<HTMLAnchorElement>('[data-gallery-category]')) {
          if (link.dataset.galleryCategory === category) link.setAttribute('aria-current', 'true');
          else link.removeAttribute('aria-current');
        }
        if (mode === 'push' && renderedSearch !== url.search) history.pushState(null, '', url.pathname + url.search);
        renderedSearch = url.search;
        const count = incoming.querySelectorAll('[data-photo-id]').length;
        status!.textContent = count ? count + (count === 1 ? ' photo shown.' : ' photos shown.') : 'No photos to show.';
      }
    } catch {
      if (controller.signal.aborted) return;
      // History restoration already changed the address. Reload the canonical page
      // rather than leaving the wrong category under the new URL.
      if (mode === 'restore') {
        location.reload();
        return;
      }
      status!.textContent = '';
      error!.textContent = 'The gallery could not load. Try again or open the link in a new tab.';
      error!.hidden = false;
    } finally {
      if (request === controller) {
        request = undefined;
        current?.removeAttribute('aria-busy');
      }
    }
  }

  gallery.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element).closest<HTMLAnchorElement>('[data-gallery-category], [data-gallery-more]');
    if (!link) return;
    event.preventDefault();
    if (link.hasAttribute('data-gallery-more') && request) return;
    void navigate(new URL(link.href), link.hasAttribute('data-gallery-more') ? 'append' : 'push');
  });
  window.addEventListener('popstate', () => {
    if (location.search !== renderedSearch) void navigate(new URL(location.href), 'restore');
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) void navigate(new URL(location.href), 'restore');
  });
}
