<div align="center">

<img src="./public/GrayznLogo.jpg" alt="Grayz'n Buffalo Bar & Grill logo" width="220">

# Grayz'n Buffalo Bar & Grill

**Production restaurant website and staff operations platform built with Astro and Cloudflare.**

[![Astro](https://img.shields.io/badge/Astro-5-BC52EE?logo=astro&logoColor=white)](https://astro.build/)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers%20%7C%20D1%20%7C%20KV%20%7C%20R2-F38020?logo=cloudflare&logoColor=white)](https://www.cloudflare.com/)
![Status](https://img.shields.io/badge/Status-Production-2ea44f)
![License](https://img.shields.io/badge/License-Proprietary-red)

**[Live Site](https://grayznbuffalo.com)** · **[Portfolio](https://joshuawerlein.com)**

</div>

---

## Overview

Grayz'n Buffalo is a full-stack restaurant platform built for Grayz'n Buffalo Bar & Grill in Mondovi, Wisconsin.

The project combines a responsive public website with authenticated staff tools for maintaining menu content, weekly specials, photography, and other frequently changing business information without requiring staff to edit source code.

The application is built with Astro and Cloudflare services, using D1 for structured content, KV for authenticated sessions, R2 for managed media, Turnstile for abuse protection, and Resend for contact delivery.

A separate scheduled Cloudflare Worker integrates the restaurant's Facebook Page while keeping Facebook scripts out of visitors' browsers.

---

## Highlights

- Production Astro application deployed on Cloudflare
- D1-backed restaurant menu and weekly-special workflows
- Authenticated staff administration
- Recurring weekly-special templates
- R2-backed image management
- KV-backed administrative sessions
- Separate scheduled Facebook Graph API integration
- Failure-tolerant Facebook feed caching
- Turnstile-protected contact delivery through Resend
- Responsive desktop and mobile interfaces
- Keyboard-accessible dialogs and lightboxes
- Reduced-motion support
- Structured SEO, sitemap, Open Graph, and LocalBusiness data
- Production deployment workflow with a completed staging-to-production launch

---

## Tech Stack

### Frontend

- Astro 5
- TypeScript / JavaScript
- HTML / CSS
- Server-rendered Astro pages
- Responsive WebP image delivery

### Cloud Platform

- Cloudflare Pages / Workers
- Cloudflare D1
- Cloudflare KV
- Cloudflare R2
- Cloudflare Turnstile

### Integrations

- Resend
- Facebook Graph API
- Google Maps
- Astro Sitemap

---

## Public Website

The customer-facing application includes:

- Responsive homepage
- Animated buffalo hero with reduced-motion fallback
- Database-backed restaurant menu
- Daily and late-night menu views
- Weekly specials
- Restaurant hours and location
- Google Maps integration
- Contact form
- Client-rendered Facebook cards from a server-cached feed endpoint
- Welcome photography
- Privacy and accessibility pages
- Mobile navigation
- Sitemap and production canonical URLs
- Open Graph metadata
- LocalBusiness structured data

Permanent menu items intentionally do not display prices. Promotional and weekly-special content may include pricing.

---

## Staff Administration

The protected `/admin` area allows restaurant staff to maintain operational content without modifying the application source.

### Menu Management

Staff can manage restaurant menu content stored in D1, including:

- Categories
- Menu items
- Descriptions
- Visibility
- Daily and late-night menu organization
- Associated item photography

### Weekly Specials

The specials system supports date-based weekly content rather than a hard-coded list.

Features include:

- Weekly records with defined date ranges
- Per-day special content
- Multiple special types per day
- Recurring weekly defaults
- Editable recurring templates
- Creation of future weeks
- Editing of previously saved weeks
- Preservation of intentionally blank fields
- Date and overlap validation

Recurring defaults populate new unsaved weeks while previously saved weeks remain unchanged.

### Welcome Photos

Staff can manage homepage photography through the administration interface.

Image metadata is stored with the application while media is managed through Cloudflare R2.

---

## Data Architecture

### D1

Cloudflare D1 stores structured application data including:

- Menu categories
- Menu items
- Weekly-special records
- Weekly-special day records
- Recurring special defaults
- Site settings
- Welcome-photo metadata

Schema changes are maintained through versioned SQL migrations.

### KV

Cloudflare KV is used for authenticated administrative sessions.

Sessions are generated server-side, expire automatically, and are delivered through secure cookies.

### R2

Cloudflare R2 stores managed site photography and cached Facebook media.

Public media access is routed through controlled application paths rather than exposing administrative storage operations directly.

---

## Facebook Feed Architecture

The Facebook integration is implemented as a separate Cloudflare Worker located in:

```text
workers/fb-feed/
```

It runs independently from the main Astro application.

### Refresh Flow

Every 30 minutes, the Worker:

1. Requests recent Page content through the Facebook Graph API.
2. Normalizes the post data required by the public website.
3. Copies supported remote media into Cloudflare R2.
4. Publishes the replacement feed and retired-post retention information together in KV.
5. After successful publication, retries cleanup of eligible retired media on every refresh.

Retired posts retain their media for four days plus five minutes, covering the
public stale-feed window and an additional cache/propagation buffer. Current post
versions and recent uploads are protected. A failed KV write never triggers pruning.
The GET endpoint serves the public feed; the browser builds its cards.

### Failure Handling

The integration is designed to fail soft.

If Facebook or another refresh dependency becomes temporarily unavailable, the Worker preserves the last known-good feed rather than replacing valid public content with a failed refresh.

The public page therefore does not depend on a live Facebook browser embed.

No Facebook SDK or third-party Facebook script is required in the visitor's browser.
The site's own script fetches the feed; server-rendered fallback content is present
before it loads. Feeds older than four days produce the Facebook-link fallback.

---

## Security

Security controls are implemented primarily on the server side.

Current protections include:

- Server-side administrative authentication
- KV-backed authenticated sessions
- Session expiration
- `HttpOnly` cookies
- `Secure` cookies
- `SameSite` cookie restrictions
- Cloudflare Turnstile
- Parameterized D1 queries
- Generated media object keys
- Restricted media routing
- Security response headers
- Non-indexable administrative routes
- Secrets stored in Cloudflare configuration rather than source control

Sensitive credentials, API tokens, and passwords must never be committed to this repository.

CSP deliberately remains Content-Security-Policy-Report-Only because Cloudflare
JavaScript Detections injects changing executable inline scripts at the edge.
Do not enforce the policy or add 'unsafe-inline' to script-src to work around this.

---

## Accessibility

Accessibility is integrated into the application rather than treated as a separate visual pass.

Implementation includes:

- Semantic controls
- Keyboard-operable dialogs
- Keyboard-operable image lightboxes
- Focus-visible states
- Focus management
- ARIA feedback where appropriate
- Reduced-motion support
- Static fallbacks for animated content
- Managed image alternative text
- Responsive navigation and layouts

---

## Performance

Performance work includes:

- Responsive WebP image variants
- Mobile-specific image delivery
- Lazy loading for non-critical media
- Explicit image dimensions to reduce layout shift
- Reduced-motion static fallbacks
- Cloudflare edge caching
- Server-rendered Astro output
- Same-origin caching of Facebook content and media
- Separate delivery strategies for desktop and mobile hero assets

---

## Project Structure

```text
grayzn-buffalo/
├── migrations/
│   └── ...                         # Versioned D1 schema migrations
│
├── public/
│   ├── images/
│   ├── buffalo-hero.webp
│   ├── buffalo-poster.webp
│   └── ...
│
├── src/
│   ├── layouts/
│   ├── lib/
│   └── pages/
│       ├── admin/
│       │   ├── index.astro
│       │   ├── menu.astro
│       │   ├── specials.astro
│       │   └── welcome-photos.astro
│       └── ...
│
├── workers/
│   └── fb-feed/
│       ├── worker.js
│       └── wrangler.toml
│
├── astro.config.mjs
├── schema.sql
├── wrangler.toml
└── README.md
```

---

## Local Development

### Requirements

- Node.js
- npm
- Wrangler / Cloudflare tooling for Cloudflare-backed local or remote operations

Install dependencies:

```bash
npm install
```

Start the Astro development server:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

Preview using the configured Cloudflare environment:

```bash
npm run preview
```

---

## Cloudflare Bindings

The main application expects these Cloudflare bindings:

| Binding | Service | Purpose |
|---|---|---|
| `DB` | D1 | Menu, weekly specials, settings, and structured content |
| `SESSIONS` | KV | Administrative sessions |
| `PHOTOS` | R2 | Managed website photography and media |

Runtime secrets/environment variables include:

- `ADMIN_PASSWORD`
- `TURNSTILE_SITEKEY`
- `TURNSTILE_SECRET`
- `RESEND_API_KEY`
- `CONTACT_TO_EMAIL`

Secret values are configured in Cloudflare and are not stored in source control.

Contact delivery requires TURNSTILE_SECRET, RESEND_API_KEY, and CONTACT_TO_EMAIL;
TURNSTILE_SITEKEY renders the browser widget. Missing server configuration returns
a controlled unavailable response and never bypasses verification or selects a
fallback recipient. CONTACT_TO_EMAIL must be a single valid email address.
Contact inputs are limited to 100 characters for name, 254 for email, and 5,000
for message. Provider failures return generic errors; the browser resets the
Turnstile widget after each submission so a retry gets a fresh token.

---

## Database

The production database is Cloudflare D1.

The current menu recovery baseline and emergency fallback share
`src/data/menu-baseline.json`. See [menu recovery instructions](recovery/README.md)
for the guarded empty-database restore. The old `migrations/seed_menu.sql` is retired;
`schema.sql` no longer inserts a partial starter menu. Production staff edits remain
authoritative and should be exported before refreshing the recovery snapshot.

Schema evolution is maintained through the SQL migrations in:

```text
migrations/
```

The repository also contains:

```text
schema.sql
```

for fresh database bootstrapping. Do not replay historical migrations over it;
existing production legacy columns are intentionally left alone. See the recovery
instructions before restoring menu data.

Production database operations should be performed deliberately against the configured remote database rather than by assuming local development data matches production.

---

## Deployment

### Admin Analytics

`/admin/analytics` uses the existing staff session and server-side Cloudflare
Web Analytics queries. It shows only recent visits, available-history visits,
daily/monthly visits, public page views, three incoming-source groups, and a
combined Facebook outbound-click count. There is no browser analytics API or
chart dependency.

Runtime configuration:

- `CF_ANALYTICS_API_TOKEN`: Pages **runtime secret**, with Account → Account
  Analytics → Read restricted to this account. Use a separate token from deployment.
- `CF_ANALYTICS_ACCOUNT_ID` and `CF_ANALYTICS_SITE_TAG`: nonsecret production
  identifiers in `wrangler.toml`. Preview properties must not replace this site tag.
- Local development reads the token from ignored `.dev.vars`; never commit it.

Authenticated schema and production queries were verified September 20, 2026:
`rumPageloadEventsAdaptiveGroups`, `sum.visits`, `count`, `datetimeHour`,
`requestPath`, `refererHost`, and the production host/site filters. Account settings
reported 15,897,600 seconds (184 days) of retention, 8,035,200 seconds (93 days)
maximum query duration, and 10,000 rows. The utility reads those settings at runtime,
splits history into bounded requests, and rejects truncated/invalid responses.
The moving retention boundary includes a two-minute request safety margin.

Visits use Chicago calendar dates, including DST. Last 30 days means today plus
29 preceding dates; current day/month are incomplete. Available history is not
lifetime traffic. Cloudflare sampling and collection exclusions still apply;
missing data before collection began cannot be recovered. Zero means no recorded
traffic in a successful query, not proof that nobody visited. Provider failures
display unavailable states rather than zeros. Page rankings use page views;
incoming sources use visits, so internal page navigation adds no incoming visits.

Facebook clicks use only `facebook_outbound_clicks_daily(date, count)`. Both page
and post links count together, including the lightbox's final outbound action.
Opening a local preview/text modal does not count. One empty, same-origin POST
increments the server's Chicago day atomically. Production host/Origin checks
reject trivial cross-site submissions; this intentionally is not fraud detection.
There are no identifiers, cookies, IP/user-agent storage, destination logs, raw
events, duplicate suppression, queues, CAPTCHA, or per-user rate limits. Repeated
activations count repeatedly. Navigation never waits for tracking; blocked scripts,
network failures, and browser context-menu navigation can miss activations.
Counts are not unique people or confirmed Facebook arrivals. Daily aggregates are
retained without individual histories.

Before deploying this feature to an existing database:

1. Apply **only** `migrations/0014_facebook_outbound_clicks.sql` to `grayzn-db`.
   Fresh databases use the updated `schema.sql`; do not replay historical ALTERs.
2. Set the Pages runtime analytics secret. The GitHub deployment token is unrelated.
3. Set `settings.facebook_click_tracking_started` to the actual Chicago rollout
   date (`YYYY-MM-DD`). Tracking stays disabled until this is present. Preserve it
   on later deployments; never infer it from the first nonzero daily total.
4. Deploy after tests and build pass. Verify authentication, both navigation layouts,
   Settings logout, the seven dashboard areas, and outbound navigation.

The workflow below does not apply D1 migrations automatically. Local tests can use
an isolated Wrangler persistence directory to avoid touching production or other
local data. Run `node --test tests/analytics.test.mjs tests/client-workflows.test.mjs
tests/post-launch.test.mjs`, the existing Facebook worker tests, and `npm run build`.

Reference: [Cloudflare dataset settings](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/),
[Web Analytics retention and sampling](https://developers.cloudflare.com/web-analytics/faq/).

The main application uses the Cloudflare configuration defined in:

```text
wrangler.toml
```

The canonical production hostname is:

```text
https://grayznbuffalo.com
```

A separate staging hostname was used before launch; grazynbuffalo.com now redirects
to the canonical production site.

The Facebook feed Worker has its own configuration under:

```text
workers/fb-feed/
```

and runs on a 30-minute scheduled trigger.

---

## Development and Release Approach

Grayz'n Buffalo replaced the previous website for the business.

Development was performed against a separate staging domain so the new system could be validated without interrupting the existing public website.

Release validation has included:

- Public route smoke testing
- Administrative workflow testing
- Mobile viewport testing
- Accessibility testing
- Contact-form delivery testing
- SEO/indexing verification
- Security review
- D1 backup and restore validation
- Production binding verification
- DNS and custom-domain cutover planning

---

## Privacy and Third-Party Services

The public website uses Cloudflare infrastructure for application delivery and security.

Contact messages are processed through Resend.

Facebook content is retrieved server-side and cached by the application. The public feed does not require a Facebook browser embed or Facebook SDK.

See the live site's Privacy page for the current user-facing disclosure.

---

## Screenshots

The screenshots below show representative public views captured before production cutover. Administrative screenshots are intentionally omitted because those routes require authentication and no credentials or private operational data are included in repository documentation.

### Homepage

#### Desktop — 1440 × 900

![Grayz'n Buffalo homepage on desktop](docs/screenshots/home-desktop.webp)

#### Mobile — 390 × 844

![Grayz'n Buffalo homepage on mobile](docs/screenshots/home-mobile.webp)

### Menu

![Grayz'n Buffalo restaurant menu](docs/screenshots/menu.webp)

### Weekly Specials

![Grayz'n Buffalo weekly specials](docs/screenshots/specials.webp)

> Screenshots were captured from the staging deployment at `grazynbuffalo.com` prior to final production cutover. No credentials, customer submissions, API tokens, or other private operational information are shown.

---

## Copyright and Usage

This repository contains software developed for a commercial client and is publicly viewable for portfolio, demonstration, technical evaluation, and recruitment purposes.

No open-source license is granted by this README. Unless a separate license explicitly states otherwise, no permission is granted to copy, modify, redistribute, sublicense, sell, deploy, or create derivative works from the source code.

Grayz'n Buffalo Bar & Grill names, trademarks, logos, photography, menu content, and other business materials remain the property of their respective rights holders.

---

## Author

Developed and maintained by **Joshua Werlein**.

- Portfolio: [joshuawerlein.com](https://joshuawerlein.com)
- GitHub: [github.com/joshua-werlein](https://github.com/joshua-werlein)
- LinkedIn: [linkedin.com/in/joshua-werlein](https://linkedin.com/in/joshua-werlein)
