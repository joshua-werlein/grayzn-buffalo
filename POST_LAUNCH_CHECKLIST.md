Grayz'n Buffalo Post-Launch Checklist
Start this checklist after Reviews / Photos is finished and the final Specials / Contact visual cleanup is deployed.
Updated: 2026-10-01
Production: https://grayznbuffalo.com
Primary production resources:
- Cloudflare Pages: grayzn-buffalo
- Active Facebook Worker: grayzn-fb-feed
- D1: grayzn-db
- R2: grayzn-photos
- Facebook Worker cron: */30 * * * *
- Facebook specials processing window: 7 AM–8 PM America/Chicago
- Last verified Facebook Worker version: 344d5be3-5203-4165-81f3-5a0d0fbc7949
- Current specials parser: PARSER_VERSION 16
Before any task, inspect the latest repository and production state. Do not rely on old handoff notes when they conflict with current source.
0. Start gate
Do not begin the final post-launch pass until:
- [ ] Reviews / Photos is complete and deployed.
- [ ] Specials page final visual cleanup is complete.
- [ ] Contact page H1/page-heading cleanup is complete.
- [ ] Weekly Facebook-specials automation has been verified in normal production use.
- [ ] Mexican Night recurring-default publication has been verified in production.
- [ ] GitHub Actions deploy workflow is green without the Node 20 action-runtime warning.
- [ ] Cloudflare lists only the intended Pages project and active grayzn-fb-feed Worker.
1. High-priority security hardening
1.1 Remove the final executable inline admin script
The existing security audit identified a remaining executable inline application script in src/pages/admin/index.astro used for the Admin-home delivery-status label.
- [ ] Inspect the latest file and confirm whether it still exists.
- [ ] If present, externalize it as a normal bundled/local script.
- [ ] Do not add 'unsafe-inline' to script-src.
- [ ] JSON-LD may remain inline because it is inert structured data.
- [ ] Build and confirm generated output contains no executable inline application scripts.
- [ ] Verify Admin delivery-status behavior after the change.
1.2 CSP verification and enforcement
CSP has intentionally remained Report-Only during launch stabilization.
Before enforcement:
- [ ] Verify CSP in src/middleware.ts.
- [ ] Verify CSP in public/_headers.
- [ ] Keep both definitions aligned.
- [ ] Check deployed responses for duplicate/conflicting CSP headers.
- [ ] Confirm required origins/directives for same-origin scripts, service worker, Turnstile, Maps, images, and current third parties.
- [ ] Keep script-src free of 'unsafe-inline'.
While still Report-Only, test:
- [ ] Home
- [ ] Menu
- [ ] Specials
- [ ] Reviews / Photos
- [ ] Contact
- [ ] Privacy
- [ ] Accessibility
- [ ] Menu tabs/deep links/jump links
- [ ] image lightboxes
- [ ] Contact + Turnstile
- [ ] Google Maps
- [ ] service-worker/install behavior
- [ ] Facebook feed
- [ ] Admin login
- [ ] Admin Menu
- [ ] Admin Specials
- [ ] Admin Photos
- [ ] Admin delivery-status display
Check headers on:
- [ ] public SSR response
- [ ] admin response
- [ ] static/public response
- [ ] relevant API responses
After all checks pass:
- [ ] Change to enforcing Content-Security-Policy.
- [ ] Deploy as a dedicated security release.
- [ ] Re-run the complete smoke test.
- [ ] Confirm no required production behavior is blocked.
Deferred unless later justified:
- removing 'unsafe-inline' from style-src
- CSP nonces/hashes
- Astro experimental CSP
- centralized CSP reporting
2. Admin, session, API, and form security
Admin authentication / authorization
- [ ] Unauthenticated users are rejected from every admin page.
- [ ] Unauthenticated users are rejected from every admin mutation/API endpoint.
- [ ] Login/logout/session-expiration behavior works.
- [ ] Authentication cookies use appropriate Secure, HttpOnly, and SameSite settings.
- [ ] Expired/stale sessions cannot mutate data.
- [ ] Admin responses are not publicly cached.
- [ ] Admin/private routes remain non-indexable.
Mutation / API protections
- [ ] Review CSRF/origin protection appropriate to the current auth model.
- [ ] CORS is no broader than necessary.
- [ ] Server-side validation rejects malformed/out-of-range inputs.
- [ ] D1 writes remain parameterized.
- [ ] Error responses do not expose stack traces, SQL, tokens, or internal configuration.
Contact / Turnstile
- [ ] Turnstile allows the final production hostname.
- [ ] Successful contact delivery is verified.
- [ ] Failure/validation messages are understandable.
- [ ] Spam/rate controls work.
- [ ] Contact content is not unnecessarily logged.
- [ ] Customer submissions are not exposed to unrelated clients.
Upload / R2 safety
- [ ] Admin image uploads enforce intended file/MIME types.
- [ ] Upload size limits are enforced.
- [ ] Arbitrary executable files cannot be served as trusted application content.
- [ ] R2 keys/URLs do not expose credentials/private metadata.
- [ ] Delete/replace behavior is correct.
3. Cloudflare / infrastructure security and resilience
Worker / bindings
- [ ] Only grayzn-fb-feed serves grayznbuffalo.com/api/facebook-feed.
- [ ] Obsolete fb-feed has not reappeared.
- [ ] Expected cron is present and no unexpected triggers/routes exist.
- [ ] D1/KV/R2/Workers AI bindings match current source.
- [ ] No unused service binding grants unnecessary access.
- [ ] Public feed endpoint exposes only intended data.
WAF / abuse controls
- [ ] Review current WAF/custom rules.
- [ ] Reassess rate limiting for Contact/Admin/API routes.
- [ ] Verify country-block rules, if retained, do not block required services.
- [ ] Verify Search / Agent / Training bot policy still matches owner intent.
- [ ] Confirm desired search crawlers are not blocked.
DNS / TLS / headers
- [ ] Apex and www behavior is correct.
- [ ] SSL/TLS has no certificate or redirect-loop issues.
- [ ] Staging/legacy redirects resolve to correct production paths.
- [ ] Audit deployed security headers:
  - CSP
  - frame protection / X-Frame-Options
  - X-Content-Type-Options
  - Referrer-Policy
  - Permissions-Policy
  - HSTS
- [ ] Do not tighten a header blindly; verify compatibility first.
Secrets
- [ ] GitHub/Cloudflare secrets exist only where required.
- [ ] No secrets/tokens/auth headers/raw Meta responses are committed.
- [ ] Logs contain no secret values.
- [ ] Review Cloudflare API-token scopes for least privilege.
- [ ] Rotate credentials only when exposure or policy requires it.
4. D1 migrations, backup, restore, and rollback
The September 27 deployment exposed that d1_migrations tracking had been out of sync with the live schema and was manually backfilled before migration 0019.
- [ ] Audit d1_migrations against the actual production schema.
- [ ] Verify migrations 0001 through 0019 are represented correctly.
- [ ] Verify no migration is recorded without its actual schema/data effects.
- [ ] Verify no applied schema change is missing from migration tracking.
- [ ] Decide/document how seed_menu.sql belongs in migration history.
- [ ] Test the next migration procedure safely so wrangler d1 migrations apply is predictable.
Backup / rollback:
- [ ] Export production D1 after Reviews/Photos and final schema changes.
- [ ] Store backup safely outside the production DB.
- [ ] Document restore steps.
- [ ] Perform at least one non-production restore test.
- [ ] Record last known-good Pages commit.
- [ ] Record last known-good Worker version.
- [ ] Document Pages rollback.
- [ ] Document Worker rollback.
Data-integrity checks:
- [ ] Menu
- [ ] weekly specials
- [ ] recurring weekly defaults
- [ ] Mexican Night recurring template
- [ ] Mexican Night current-week live collection
- [ ] photos/R2 metadata
- [ ] analytics tables
- [ ] Facebook import/audit tables
5. Facebook specials automation final verification
Weekly lifecycle
- [ ] New week is created from recurring defaults.
- [ ] New live-week defaults are unlocked automation fallbacks.
- [ ] Facebook can replace eligible defaults.
- [ ] Genuine staff/manual corrections remain protected.
- [ ] Past days are never backfilled.
- [ ] Same-week reruns are idempotent.
Extraction regression checklist
Current deployed implementation (verified 2026-10-01):
- [x] Gemma model: @cf/google/gemma-4-26b-a4b-it
- [x] PARSER_VERSION 16
- [x] structured JSON-schema extraction
- [x] malformed/prose retry
- [x] per-attempt AI accounting
- [x] current-day-only processing / no prior-day backfill
- [x] ONLY / SPECIAL normalization
- [x] both $10.25 and $.99 price styles are valid
- [x] 150-character/fail-closed protections
- [x] same-day no-weekday fallback: a post created today may be treated as today's poster when day_of_week=-1, no weekday conflicts exist, and the heading is not forward-looking
- [x] forward-looking safeguards reject tomorrow, this weekend, next <weekday>, next week, and later this week; tonight remains eligible
- [x] all-week/weekly-lunch extraction remains on its separate reconciler path
- [x] Full Worker suite after Mexican Night implementation: 406/406 tests passed, 0 failures; Astro type check: 0 errors
Production verification still required:
- [ ] Verify the next ordinary daily poster without an explicit weekday updates eligible Lunch/All Day slots correctly.
- [ ] Verify daily poster prices overwrite eligible price-less weekly-lunch baselines.
Mexican Night
Implementation deployed 2026-10-01 with Worker version 344d5be3-5203-4165-81f3-5a0d0fbc7949:
- [x] Dedicated non-leading MEXICAN_NIGHT_ONLY_SCHEMA extraction path.
- [x] Mexican Night is confirmed only from visible poster evidence; Tuesday, Tonight, venue name, or 5–10 PM alone do not qualify.
- [x] Generic daily-offers shape containing visible Mexican Night evidence triggers MEXICAN_NIGHT_SHAPE_ERROR and targeted retry.
- [x] Tuesday generic extraction with offers: [] gets one targeted Mexican Night retry.
- [x] Successful Mexican Night validation routes to target_kind='section' and target_collection_id='mexican-night' in both normal and reprocess paths.
- [x] Failed/uncertain targeted retry fails closed and leaves recurring defaults untouched.
- [x] Existing manual-correction/manual-lock protections remain in place.
- [x] Standing substitutions/add-ons are preserved when the Facebook poster omits them; poster-provided changes replace defaults only when explicit evidence supports them.
- [ ] Verify the first natural production Mexican Night import next Tuesday and confirm the live section source becomes Facebook when appropriate.
Mexican Night lifecycle / presentation
- [ ] New-week publication seeds detailed Mexican Night from recurring defaults.
- [ ] Correct upcoming Tuesday/week metadata is stored.
- [ ] Sunday/Monday/Tuesday detail visibility works.
- [ ] Wednesday 1:59 AM Chicago is visible.
- [ ] Wednesday 2:00 AM is hidden.
- [ ] Hiding does not delete data.
- [ ] Facebook replaces eligible weekly Mexican Night values.
- [ ] Current-week manual corrections remain protected during that week.
- [ ] Following week's rollover uses the current recurring defaults.
- [ ] Standing substitutions/add-ons survive a weekly Facebook poster that does not explicitly replace them.
- [ ] Poster-provided substitution/add-on updates replace defaults only when evidence supports them.
6. Reviews / Photos final verification
After the feature is complete:
- [ ] Review data/source is exactly what the UI claims.
- [ ] "Leave a Review" reaches the correct Google Business Profile.
- [ ] "Add Photos" reaches the intended Google flow.
- [ ] External-link behavior is clear.
- [ ] Desktop/mobile behavior works.
- [ ] Empty/failure states work.
- [ ] No Google/API key is unnecessarily exposed client-side.
- [ ] Any required API key is properly restricted.
- [ ] Privacy page reflects the finished Google integration/data flow.
7. Lighthouse / performance / Core Web Vitals
Run this after Reviews / Photos and final Specials changes are deployed.
Required fresh Lighthouse runs:
- [ ] Home desktop
- [ ] Home mobile
- [ ] Menu desktop/mobile
- [ ] Specials desktop/mobile again
- [ ] Contact desktop/mobile
- [ ] Reviews / Photos desktop/mobile
Review:
- [ ] Performance
- [ ] Accessibility
- [ ] Best Practices
- [ ] SEO
- [ ] LCP
- [ ] CLS
- [ ] INP/TBT where applicable
- [ ] transferred bytes
- [ ] image recommendations
Specific follow-ups:
- [ ] Confirm hero/image optimization did not regress LCP or visual quality.
- [ ] Re-check Menu desktop CLS/font loading.
- [ ] Confirm Reviews/Photos does not add excessive third-party payload.
- [ ] Review Cloudflare real-user/Core Web Vitals after enough production traffic accumulates.
8. Accessibility final audit
- [ ] Axe/accessibility checks: Home, Menu, Specials, Reviews/Photos, Contact, Privacy, Accessibility, 404.
- [ ] Exactly one meaningful H1 per public page.
- [ ] Re-check semantic heading hierarchy after Contact/Specials changes.
- [ ] Keyboard-test navigation.
- [ ] Keyboard-test Menu tabs/jump links.
- [ ] Keyboard-test lightboxes and focus restoration.
- [ ] Visible focus indicators.
- [ ] Logical focus order.
- [ ] Meaningful alt text / decorative-image handling.
- [ ] Form labels, validation, and status/error announcements.
- [ ] Accessible names for phone/address/review/photo links.
- [ ] Mobile persistent navigation does not cover content/controls.
- [ ] Reduced-motion behavior works.
9. Privacy and Accessibility page accuracy
Privacy
Review against the actual finished production site:
- [ ] Cloudflare hosting/security
- [ ] Cloudflare Web Analytics
- [ ] contact submissions
- [ ] Turnstile
- [ ] Google Maps
- [ ] Reviews / Photos / Google integration
- [ ] Facebook feed
- [ ] automated Facebook-specials processing
- [ ] data-retention statements
- [ ] cookies/local storage/service worker behavior
- [ ] logs/operational data
- [ ] third-party links
- [ ] privacy contact information
Do not claim data collection/sharing that does not occur, and do not omit data flows that do occur.
Accessibility
- [ ] Claims remain accurate after final UI changes.
- [ ] Do not claim formal WCAG conformance unless supported.
- [ ] Current keyboard/contrast/reduced-motion/form/semantic/responsive accommodations are described accurately.
- [ ] Accessibility contact path is current.
- [ ] Update review/update date if displayed.
10. SEO, indexing, links, and metadata
- [ ] Crawl all public routes for broken links/images, redirect chains, unexpected 404s.
- [ ] Verify custom 404.
- [ ] Verify page titles/descriptions.
- [ ] Canonicals use https://grayznbuffalo.com.
- [ ] Open Graph/Twitter URLs/images are current.
- [ ] Restaurant/LocalBusiness structured data is valid.
- [ ] Address, phone, hours, menu URL, social profile are correct.
- [ ] Sitemap includes intended public pages, including Reviews/Photos if appropriate.
- [ ] robots.txt is correct.
- [ ] No public production page accidentally has noindex.
- [ ] Admin/private routes remain non-indexable.
- [ ] Search repo/build output for stale:
  - grazynbuffalo.com
  - old Gumby's URLs
  - localhost URLs
  - obsolete business information
- [ ] Verify apex/www/legacy redirects.
- [ ] Review Search Console after final route/metadata changes.
- [ ] Re-submit sitemap only if needed.
11. Final production smoke test
Public:
- [ ] Home
- [ ] hero + reduced motion
- [ ] homepage specials
- [ ] Welcome photos/lightbox
- [ ] Facebook feed
- [ ] Menu Daily/Late Night
- [ ] Menu deep links/jump navigation
- [ ] Specials current/next week
- [ ] Mexican Night
- [ ] Reviews/Photos
- [ ] Contact/Turnstile
- [ ] Google Map/address fallback
- [ ] Privacy
- [ ] Accessibility
- [ ] 404
- [ ] mobile navigation/footer
Admin:
- [ ] login/logout
- [ ] Menu CRUD/order/availability/Late Night
- [ ] image upload
- [ ] weekly specials
- [ ] recurring weekly defaults
- [ ] Mexican Night recurring defaults
- [ ] Mexican Night current-week corrections
- [ ] Photos management
- [ ] delivery status
- [ ] Analytics
- [ ] unauthorized access rejected
12. Dependency and source-control maintenance
- [ ] npm ci from a clean checkout.
- [ ] npm run build.
- [ ] astro check.
- [ ] All test suites.
- [ ] Review npm audit; assess actual production relevance before changing dependencies.
- [ ] Review outdated packages with security/support implications.
- [ ] GitHub Actions is green on current action runtimes.
- [ ] No generated screenshots/temp scripts/secrets/local settings/stale worktree artifacts are committed.
- [ ] Remove obsolete branches/worktrees only after confirming work is merged/superseded.
- [ ] main matches deployed production source.
13. Documentation refresh
README
The README is known to be outdated. Update it with:
- [ ] production/development domains
- [ ] current Astro/Cloudflare architecture
- [ ] Pages deployment workflow
- [ ] active Worker grayzn-fb-feed
- [ ] D1 / KV / R2 usage
- [ ] analytics implementation
- [ ] Facebook-specials automation
- [ ] Gemma + parser 16
- [ ] structured extraction/retry/fail-closed behavior
- [ ] automatic week creation
- [ ] recurring defaults/manual protection
- [ ] Mexican Night recurring-template/live-week lifecycle
- [ ] migrations through 0019
- [ ] admin capabilities
- [ ] final CSP/security state
- [ ] development/test commands
- [ ] deployment and rollback notes
Do not include secret values.
Other docs
- [ ] Update docs/facebook-specials-auto.md to parser 16, same-day no-weekday fallback, weekly-lunch separation, and Mexican Night targeted retry/routing.
- [ ] Review/update MEXICAN_NIGHT_AUTOMATION.md after the first natural Tuesday production verification; implementation is deployed but live Facebook replacement still needs observation.
- [ ] Preserve useful audit history; remove/archive only clearly superseded material.
14. Portfolio case study
Update the Grayz'n Buffalo portfolio case study with:
- [ ] business problem / redesign / cutover
- [ ] Astro + Cloudflare architecture
- [ ] D1/R2/KV
- [ ] responsive/mobile design
- [ ] admin system
- [ ] analytics dashboard
- [ ] Facebook feed
- [ ] Facebook Specials automation:
  - Facebook post/image
  - Workers AI / Gemma
  - structured validation
  - deterministic reconciliation
  - guarded D1 writes
  - recurring fallbacks
  - manual/staff protection
  - current-day/no-backfill safeguards
- [ ] automatic week creation
- [ ] Mexican Night recurring-template + weekly update lifecycle
- [ ] retries, fail-closed behavior, tests, auditability
- [ ] substantiated SEO/search/mobile outcomes
- [ ] engineering tradeoffs / lessons learned
Do not expose client secrets, private admin details, tokens, or sensitive operational information.
15. Closeout
Before declaring post-launch hardening complete:
- [ ] High-priority security work complete.
- [ ] Enforcing CSP live and verified.
- [ ] D1 backup + tested restore procedure complete.
- [ ] Final Lighthouse/accessibility audit reviewed.
- [ ] Privacy and Accessibility pages current.
- [ ] No critical broken links or functional regressions.
- [ ] Reviews/Photos verified.
- [ ] Specials/Facebook/Mexican Night automation verified in normal production use.
- [ ] README current.
- [ ] Portfolio case study current.
- [ ] GitHub main, Pages deployment, and active Worker represent the same intended production source.
- [ ] Last known-good commit, Worker version, and rollback procedures recorded.
After this checklist is complete, remaining work should be routine maintenance rather than launch hardening.