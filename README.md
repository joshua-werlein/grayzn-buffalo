# Grayz'n Buffalo Bar & Grill — Website

Astro + Cloudflare (Pages, D1, KV, Turnstile, Resend). Design: approved homepage v11.

## First-time setup

```bash
npm install

# 1. Create resources
npx wrangler d1 create grayzn-db          # paste database_id into wrangler.toml
npx wrangler kv namespace create SESSIONS # paste id into wrangler.toml

# 2. Load the schema + seed data
npx wrangler d1 execute grayzn-db --remote --file=schema.sql

# 3. Build
npm run build
```

## Deploy (Cloudflare Pages)

Option A — direct upload:
```bash
npx wrangler pages deploy dist --project-name grayzn-buffalo
```
Option B (recommended): push to a Git repo and connect it in Pages for auto-deploys.

Then in the Pages project → Settings:
- Bindings: D1 `DB` → grayzn-db, KV `SESSIONS` → your namespace
- Environment variables / secrets:
  - `ADMIN_PASSWORD` — staff admin login
  - `TURNSTILE_SITEKEY` + `TURNSTILE_SECRET` — from CF Turnstile (create widget for the domain)
  - `RESEND_API_KEY` — from Resend
  - `CONTACT_TO_EMAIL` — where contact form emails go

Custom domains: add **grazynbuffalo.com** (staging preview) now; add **grayznbuffalo.com** at launch
(remove the old Weebly A/CNAME records when doing so).

## Admin

`/admin` — password login (ADMIN_PASSWORD). Sessions in KV, 24h.
- `/admin/menu` — add / hide / delete menu items per category. No prices by design.
- `/admin/specials` — edit the 7 day-of-week specials (name, description, tag).

## Facebook feed

`workers/fb-feed/` is a separate Worker: cron every 30 min pulls page posts via Graph API
(Meta Business Manager **System User token**), caches in KV, serves JSON.
Wire the homepage `#fbFeed` section to its URL once deployed. No FB scripts run in visitors' browsers.

## Notes

- Old Weebly site keeps serving grayznbuffalo.com until launch (records grey-clouded).
- gumbysbar.com 301 redirect happens post-launch (registrar: Register.com).
- LocalBusiness JSON-LD is in the Base layout. Hours: daily 10 AM – 2 AM.
