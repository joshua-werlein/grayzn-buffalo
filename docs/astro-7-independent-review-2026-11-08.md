# Independent Turnstile, Specials and Astro 7 review — November 8, 2026

Status: local preparation only. No push, production deployment, route activation,
secret rotation, production contact submission/email or production storage write.
Times in this report use America/Chicago; some existing runbook/API timestamps are
November 9 UTC while the local date is November 8.

## Repository safety and scope

Fetched origin before editing: `main` and `origin/main` were both `dd10dc2`.
Migration began at `8758391`, descending through `914d5f6` and `f55003a` from
`dd10dc2`. Its only pre-existing uncommitted changes were Claude's deployment
workflow and release runbook updates. Those exact changes were preserved in
`57c4ff6` before independent documentation corrections.

No worktree was reset or cleaned. The current-source changes were committed on
`codex/contact-specials-review-20261108`, leaving `main` at `dd10dc2`:

| Change | Current-source branch | Migration branch |
|---|---|---|
| Responsive recurring cards and regression | `388dbee` | `c44e546` |
| Turnstile rejection/replay regressions | `2c7fb98` | `a8441c3` |

The migration already contains both patches. A future fast-forward of main to the
reviewed migration includes them; do not restore an older Specials file when
reconciling branches. Besides runtime-binding and missing-Origin compatibility
adaptations, the recurring-grid CSS is the migration's only new application change.
No differences from `dd10dc2` exist in `workers/fb-feed`, migrations or schema. November staff editing, automation
ownership, Facebook retry/image fixes and authentication logic are preserved.

## Turnstile finding

The dashboard warning is present, but its literal implication that Siteverify has
never been integrated is contradicted by the widget's own historical analytics.

Read-only dashboard evidence, before this review generated any form submission:

| Window | Challenges issued | Solved | Siteverify requests | Valid | Invalid |
|---|---:|---:|---:|---:|---:|
| Last 24 hours | 8 | 6 | 0 | 0 | 0 |
| Last 7 days | 43 | 27 | 14 | 14 | 0 |

The production contact page's `data-sitekey` exactly matches the dashboard's
existing "Grayzn Buffalo contact form" widget. The widget renders a success state
without submitting the form. Contact and staff login use the same configured
sitekey/secret names, so the 14 historical successes cannot be attributed to the
contact route specifically. No secret value was displayed, read back, rotated or
compared in plaintext. Successful historical validation is evidence that this
widget has a working server-side credential pairing; it does not prove current
Resend delivery or independently prove the copied Worker's encrypted values.

**Conclusion:** zero recent validations are the observed condition behind the
warning. Low recent submission/login volume is the best-supported explanation.
There is no evidence of an absent Siteverify implementation or an active widget
mismatch. The dashboard still displays the warning alongside seven-day successes;
its exact alert lookback/cache refresh policy was not established, so a stale
warning or analytics lag cannot be definitively excluded. Do not rotate credentials
or replace the widget to clear this warning.

Source review and local mocked tests establish:

- Browser submissions include the widget token in JSON to `/api/contact`.
- Malformed input, missing contact configuration and missing/oversized tokens stop
  before provider calls. These paths legitimately create no Siteverify metric.
- A valid request calls Cloudflare Siteverify with the configured secret and token.
  Only HTTP success and the boolean `success: true` can reach Resend.
- Invalid, expired/duplicate and invalid-secret results deny delivery. Provider
  errors, invalid JSON and nonboolean success values fail closed.
- Every submission revalidates; a mocked first redemption sends exactly once and
  a second redemption returns 400 without a second Resend call.
- Resend errors remain generic, HTML is escaped, and only the configured recipient
  is used. The client resets the single-use widget after success and failure.
- Astro 7 changes the binding accessor only; validation and delivery order remain
  unchanged. The real workerd rehearsal separately proves middleware supplies
  bindings to rendered pages/endpoints.

No application security correction was warranted by this evidence. Six explicit
Turnstile regression cases were added in each branch. These use fake credentials
and intercepted fetch; they send no network requests or mail.

Cloudflare documents [token validation metrics](https://developers.cloudflare.com/turnstile/turnstile-analytics/token-validation/)
and [mandatory server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/):
tokens expire after five minutes and may be redeemed once. A solved widget is not
itself a submission or server validation.

**Remaining limit:** no production POST was performed. Contact delivery through the
live Pages secrets and Resend is not end-to-end certified. A separately authorized
normal contact submission and inbox receipt check would close that gap; it is not
required merely to show that the dashboard warning is not proof of missing code.

## Responsive layout

Changed only the recurring grid/card sizing rules, retaining 10px gaps, existing
colors/fonts, contents, links and interaction styles. Desktop has three explicit
`minmax(0, 1fr)` tracks, widths through 1023px have two, and widths through 520px
have one. Cards have zero minimum width and can wrap long words.

Verified with real browser geometry against generated compiled-page fixtures and
production CSS from **both Astro 5 and Astro 7** builds:

| Actual CSS viewport | Columns × rows | Card/page overflow |
|---|---|---|
| 375px | 1 × 6 | None |
| 390px | 1 × 6 | None |
| 768px | 2 × 3 | None |
| 1024px | 3 × 2 | None |
| 1440px | 3 × 2 | None |
| 1920px | 3 × 2 | None |

All six fixture cards were about 82.53px tall, with equal track widths within
subpixel rounding and 10px horizontal/vertical gaps. No scroll clipping or fixed
heights were introduced. The browser's existing 125% zoom was accounted for and
actual `innerWidth` was checked; temporary viewport overrides were reset.
`tests/recurring-grid.test.mjs` rejects restoration of auto-fit or later conflicting
recurring-grid overrides. Existing compiled layout/link tests remain in place.

## Independent migration review

Reviewed the entire source/test/configuration diff from `dd10dc2`, the dependency
manifest/lock changes, generated configuration and both readiness/runbook documents.

| Area | Finding |
|---|---|
| Versions | Installed and locked Astro 7.4.7, adapter 14.4.6, Wrangler 4.158.0; fresh npm dist-tags match Astro/adapter. |
| Node | Running 24.22.2, matching `.nvmrc`; engine `^24.22.2`. Current maintained 24.x patch, not the newest Node major. |
| Dependency security | Fresh unrestricted npm audit: zero info/low/moderate/high/critical findings. Sharp 0.35.5 and Undici 7.30.2 overrides retained. |
| Runtime | All 22 binding consumers use the helper; middleware injects `cloudflare:workers` env before execution. Existing test-clock access remains separate. |
| Authentication | Password/session/KV behavior, private media authorization, origin guards and no-store headers retained. Migration preserves missing-Origin form denial. |
| Build/assets | Only `dist/client` is public; server bundle excluded, source-map upload off; no extra Astro SESSION or IMAGES resource. |
| Storage | D1, session KV and photo R2 identifiers match retained Pages configuration. No schema or production data change. |
| Secrets | Fresh names-only guard passes: ADMIN_PASSWORD, CF_ANALYTICS_API_TOKEN, CONTACT_TO_EMAIL, RESEND_API_KEY, TURNSTILE_SECRET and TURNSTILE_SITEKEY present; no analytics [vars] name is duplicated as a secret. Values remain unverified. |
| Analytics vars | Unrouted active version `253ed164` lacks both public analytics vars after owner removed duplicate secrets. Next authorized deployment must restore the two configured [vars]; verify before routing. |
| CI credential | GitHub secret name exists. Account dashboard shows only Individual Workers Editor for `grayzn-buffalo`; no Facebook/resource-wide policy shown. Cannot prove encrypted GitHub secret matches that token without using it in an authorized run. |
| CI workflow | Check/build/both suites/secret guard precede Worker deploy. Dedicated Worker token; Pages token retained. Explicit bash activates pipefail. YAML parses; all 47 lines are CRLF, no bare LF. |
| Routing | Source/generated config have no routes. Live site Worker has no routes/custom domains; workers.dev and previews off. Live Facebook feed/webhook patterns retained. |
| Capacity | Billing independently confirms subscribed Workers Paid. Production edge CPU/error behavior still requires post-cutover verification. |
| Rollback | Retained Pages URL returns 200; deployment remains `d5cfa3ed` / `dd10dc2`. Removing only future site route returns traffic to Pages; keep Facebook routes and shared writes. |

Read installed Wrangler implementation independently: `triggersDeploy` invokes
`publishRoutes` only when route entries exist. Script-scoped route publication
replaces that Worker's route set. Its dashboard comparison fetches routes/domains
only if declared, and deployment explicitly reapplies disabled subdomain/preview
settings. This supports the route-omission strategy and restricted token scope.
[Cloudflare's permission documentation](https://developers.cloudflare.com/workers/authorization/workers/)
and [the upstream route-permission fix](https://github.com/cloudflare/workers-sdk/pull/16531)
support these findings. Actual CI compatibility remains untested until an
authorized deploy; no scope widening is recommended preemptively.

Documentation corrections: the release runbook now distinguishes historical
owner actions from this read-only review, records independently checked plan/token
scope, removes a stale statement that today's guard still fails, and corrects
"revert the migration merge" because the proposed integration is a fast-forward.
Both earlier readiness documents retain historical checkpoints; this report and
the updated release runbook supersede their old capacity/secret blocker status.

## Validation evidence

The complete migration application suite passed **437/437**, with zero failures,
skips or cancellations (549.42 seconds). The complete Facebook Worker suite passed
**1,730/1,730**, with zero failures, skips or cancellations (1,041.39 seconds).
Initial sandbox attempts could not connect to the local emulator; both complete
migration suites were rerun with localhost access and passed. Ignored local evidence is under `.wrangler/independent-*`; these logs contain synthetic test fixture data.

- Migration build passed; Astro check: 0 errors, 0 warnings, 14 existing hints.
- Current-source Astro 5 build and check passed (0 errors/warnings, 21 hints).
  Full suite: 428 cases, 425 passed in the sandbox; three local D1 cases hit
  localhost EACCES. All three passed on unrestricted retry (5/5 across their
  containing files). Focused layout/contact run: 11/11 passed.
- Migration focused deployment/secret/contact/grid run: 16/16 passed.
- Both Wrangler dry runs passed: site 1,156.36 KiB / 287.63 KiB gzip;
  Facebook 369.00 KiB / 92.16 KiB gzip. No live upload.
- Fresh actual workerd rehearsal passed public routes, protected/authenticated staff
  pages, CSRF denial, local multipart photo round trip, private originals and 404
  for `/server/entry.mjs`. Disposable local D1/KV/R2 and fake session only; outbound
  providers disabled.
- Read-only production GETs: Home/Menu/Specials/Contact/login 200, protected staff
  pages 302 with no-store, existing WebP 200, Facebook feed 200, unsupported feed
  query 404, server bundle 404, retained Pages URL 200.
- Site Worker active version remains `253ed164-ee6b-4aa1-bf0b-ef82f5dd5775`;
  Facebook remains `eb32d3f0-f0bc-47a9-9b92-21282c359dfd`, both at 100%.

## Release recommendation and remaining gates

Local implementation is suitable for the next separately authorized **unrouted CI
deployment**; all requested local verification has passed. Do not add a production
route as part of preparation or interpret this report as push/deploy authorization.

1. Recheck main, active deployments, secret names, resource identities and Facebook
   routes for drift. Recheck dependencies if release is delayed. Node has an
   [announced November 11 security release](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases);
   use the patched 24.x version when available and revalidate.
2. After explicit authorization, integrate the reviewed migration (already includes
   both local fixes) and prove the dedicated CI credential by deploying while still
   unrouted. Confirm the two analytics vars are restored and six secrets retained.
3. Require separate authorization before dashboard-managed `grayznbuffalo.com/*`
   activation. Keep DNS, Pages, www redirects and Facebook routes intact.
4. Immediately check public/staff pages, images, auth, no-store/security headers,
   zone-injected analytics beacon, real analytics data and edge CPU/errors.
   Live contact delivery needs separate email-test authorization.
5. On regression, remove only the recorded site route, verify retained Pages and
   both Facebook endpoints, and preserve shared D1/KV/R2 writes. Retain Pages and
   its credentials. Any later restoration of Pages CI needs reviewed reversions
   of migration-only build/deployment changes, preserving application fixes.

No known source-level security defect was found in this migration review. The
unverified items above are operational release gates, not grounds to weaken
Turnstile, expose the unrouted Worker or rotate working credentials.

## Handoff state

Final origin/main drift check remained `dd10dc2`. Application fixes and tests are
committed separately on both review branches as listed above. The final review
commit contains only this report and release-runbook corrections. No production
state was changed. The still-unrouted Worker will need the new layout/code and
analytics vars from the next authorized CI deployment before any route activation.
