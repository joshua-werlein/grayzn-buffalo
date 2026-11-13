# Google Images cleanup (November 12, 2026)

Goal: decorative site graphics stay visible on the pages but stop appearing as
standalone Google Images results. The six public pages (Home, Menu, Specials,
Contact, Privacy, Accessibility) stay indexable.

## Mechanism

The site is an Astro 7 app on Cloudflare **Workers** with static assets
(`dist/server/wrangler.json`: `"assets": {"directory": "../client"}`). Files in
`public/` are copied to `dist/client/` and served by the static-asset layer before
the Worker runs, so `src/middleware.ts` never sees them. Workers static assets apply
`public/_headers` (copied to `dist/client/_headers`). This deployment already relies
on it: the security headers come from its `/*` rule, and the Cloudflare adapter itself
writes the immutable `/_astro/*` cache rule into the same file at build time.

Each unwanted file gets its own exact-path rule:

```
/logo-wordmark.webp
  X-Robots-Tag: noindex
```

- There is no blanket image rule and no wildcard over the site root.
- `robots.txt` is unchanged and still allows crawling. Google must fetch the image
  to read its `noindex` header, so the images must not be disallowed there.
- The header affects only the standalone image URL. The pages that show the image
  keep their own indexing, and the image still loads normally for visitors.
- Caching, ETags, HSTS, CSP (Report-Only) and the other security headers are unchanged:
  `_headers` rules are merged.

## Image URLs excluded (`X-Robots-Tag: noindex`)

| URL | What it is | Where it is used |
|---|---|---|
| `/logo-wordmark.webp`, `/logo-wordmark-600.webp` | Top half of the logo ("Grayz'n Buffalo" lettering only) | Homepage hero animation layer, preloaded |
| `/logo-bar-grill.webp`, `/logo-bar-grill-450.webp` | Bottom of the logo ("Bar & Grill" only) | Homepage hero animation layer |
| `/buffalo-hero.webp` | Animated running buffalo | Homepage hero |
| `/buffalo-poster.webp` | Still frame of that buffalo (reduced motion) | Homepage hero |
| `/buffalo-walk-cycle.webp` | Animated walking buffalo | Footer, every page |
| `/footer-contact.webp` | "Contact Us — Send a Message" sign artwork | Footer link to /contact |
| `/footer-landscape-cutout.webp`, `/footer-board-extension.webp` | Footer scenery and wood board | Footer CSS backgrounds |
| `/grayznBackground.webp`, `/grayznBackground-1200.webp`, `/grayznBackground-1600.webp` | Hero background | Homepage CSS background, preloaded |
| `/parchment-texture.webp` | Paper texture | CSS backgrounds |

Already excluded before this change, and unchanged: `/images/welcome/*`,
`/images/menu/*`, `/images/facebook/*` (decorative frames, flourishes and templates).

## Images deliberately left indexable

- `/social-share-black-white.png` and `/GrayznLogo.png` / `/GrayznLogo.jpg`: the
  **complete** logo (lettering, buffalo, trees, "Bar & Grill").
- `/apple-touch-icon.png`, `/favicon-*.png`, `/icon-*.png`: site icons.
- `/buffalo-mark.svg`, `/buffalo-mark-gold.svg`: the header logo mark, with
  alt text "Grayz'n Buffalo Bar & Grill logo".
- `/logo-buffalo.webp`, `/logo-cream.webp`, `/logo-ink*.webp`: not referenced by the
  current pages. Left alone rather than guessed at.
- Food, menu and restaurant photography under `/img/...`. These are Worker
  responses from R2; `_headers` never applies to them.

## SEO reference corrected

The `BarOrPub` structured data in `src/layouts/Base.astro` used
`/apple-touch-icon.png` (the buffalo icon alone) as `image`. It now uses
`/social-share-black-white.png`, the complete logo that Open Graph and Twitter
already used. No image files were created or edited.

Unchanged: canonical tags, the `www`/HTTP canonical redirects, legacy `.html`
redirects, the sitemap (same six pages), `robots.txt`, and page-level robots rules.

## Local verification (wrangler dev on the built Worker, November 12, 2026)

- All 14 excluded URLs return `200 image/webp` with `x-robots-tag: noindex`, and keep
  `x-content-type-options`, HSTS, CSP-Report-Only, ETag and `Cache-Control`.
- The allowed images above, `robots.txt`, `sitemap-index.xml` and `sitemap-0.xml`
  return 200 with no `X-Robots-Tag`.
- With `Host: grayznbuffalo.com`, all six pages return 200 with no `X-Robots-Tag`, no
  robots meta, and correct canonicals. On a non-production host they are
  `noindex, nofollow` by the existing preview rule, as before.
- Every static image the homepage references returns 200. R2-backed `/img/...` photos
  return 404 locally only because the local R2 bucket is empty.

Production edge behavior (Cloudflare caching, any Transform Rules or dashboard
settings) can only be confirmed after deployment.

## After deployment

```bash
# Excluded: expect "x-robots-tag: noindex"
for p in logo-wordmark.webp logo-wordmark-600.webp logo-bar-grill.webp logo-bar-grill-450.webp \
  buffalo-hero.webp buffalo-poster.webp buffalo-walk-cycle.webp footer-contact.webp \
  footer-landscape-cutout.webp footer-board-extension.webp grayznBackground.webp \
  grayznBackground-1200.webp grayznBackground-1600.webp parchment-texture.webp; do
  printf '%-30s ' "$p"; curl -sI "https://grayznbuffalo.com/$p" | grep -iE '^(HTTP|x-robots-tag)' | tr -d '\r' | tr '\n' ' '; echo
done
# Allowed: expect 200 and NO x-robots-tag
for p in social-share-black-white.png GrayznLogo.png apple-touch-icon.png buffalo-mark.svg; do
  printf '%-30s ' "$p"; curl -sI "https://grayznbuffalo.com/$p" | grep -iE '^(HTTP|x-robots-tag)' | tr -d '\r' | tr '\n' ' '; echo
done
# Pages: expect 200 and NO x-robots-tag
for p in / /menu /specials /contact /privacy /accessibility; do
  printf '%-15s ' "$p"; curl -sI "https://grayznbuffalo.com$p" | grep -iE '^(HTTP|x-robots-tag)' | tr -d '\r' | tr '\n' ' '; echo
done
```

Use Search Console's URL Inspection → "Test live URL" on one excluded image URL
(for example `https://grayznbuffalo.com/footer-contact.webp`). It should report
indexing disallowed by the `X-Robots-Tag` header.

## Optional: faster removal from Google Images

The images drop out after Google recrawls them, which takes days to weeks. Nothing has
been removed yet. To hide them sooner, the owner can submit **temporary removals**
(about six months, and the `noindex` keeps them out afterwards):

1. Search Console → property `grayznbuffalo.com` → **Removals** → **New request**.
2. Choose **Temporarily remove URL** → **Remove this URL only**.
3. Enter one URL at a time, for example
   `https://grayznbuffalo.com/logo-wordmark.webp`. Repeat for each URL in the excluded
   table. The ones most likely to appear are the two `logo-wordmark` files,
   `buffalo-hero.webp`, `buffalo-poster.webp`, `buffalo-walk-cycle.webp` and
   `footer-contact.webp`.
4. Do not submit the page URLs or the complete-logo images.

Submit removals only after the deployment is verified with the commands above.
