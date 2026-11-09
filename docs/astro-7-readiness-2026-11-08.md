# Astro 7 migration readiness — November 8, 2026

**STOP: not cleared for production cutover on the current Workers Free plan.** Implementation and local validation are complete; capacity and operational release prerequisites below are not all cleared. No site Worker, routing change, plan upgrade, production migration or secret transfer was performed.

> **Update (later November 8):** the owner reports Workers Paid is active, which clears the capacity gate below. The remaining token, secret and cutover steps are in `astro-7-release-prep-2026-11-08.md`.

## Released security checkpoint

The separately authorized Pages release is committed and pushed as `dd10dc267ce2c7f8c3523c2f782b4906912ec36d` on main. It contains only the two photo routes, shared WebP signature/length validator, twelve regressions and audit report. Fresh release verification: 421 application tests, production build, Astro check (zero errors/warnings), and whitespace review passed.

[GitHub Actions run 42523317041](https://github.com/joshua-werlein/grayzn-buffalo/actions/runs/42523317041) succeeded. Production Pages deployment is `d5cfa3ed-5538-4d93-a59b-1d8fa330fa23`, created at 3:05 PM CST. Homepage, Menu, Specials, Facebook feed and existing full/thumbnail R2 images are healthy. Private/admin GET protection remains intact. No authenticated production upload or content mutation was made. The dedicated Facebook Worker remains `eb32d3f0-f0bc-47a9-9b92-21282c359dfd`, 100%; Sunday recovery and alert resolution remain intact.

## Isolated implementation and October reuse

Worktree: `.worktrees/astro7-security-nov8`, branch `codex/astro7-security-20261108`, based on verified main `dd10dc2`. Main retains the Pages configuration. Both historical October branches/worktrees remain intact and were clean when inspected:

- `maintenance/astro-security-20261025` / `8c6bc46`: reused the reviewed runtime-binding helper, missing-Origin compatibility approach, hashed build-output discovery and deployment separation. Did not merge/cherry-pick its old application snapshot or lockfile.
- Node checkpoint `f6ee72a`: its patched-runtime policy and explicit Facebook source-map setting were already present on current main. Retained those changes; updated the migration's Node 24 pin only.

The new migration updates all **22** current binding consumers, including November's Automation Review, approval/dismissal/Wing endpoints and retired Events redirect. Staff/menu/specials business logic and all `workers/fb-feed` files are unchanged. No migration SQL, schema bootstrap, resource IDs, auth/session algorithm or CSP policy was changed.

Configuration:

- Astro 7.4.7 and Cloudflare adapter 14.4.6, verified from npm package metadata on November 8. Adapter 14 requires Workers; [Pages support was removed](https://docs.astro.build/en/guides/integrations-guide/cloudflare/#removed-cloudflare-pages-support).
- `cloudflare:workers` bindings are made available in middleware; the helper retains explicit injected environments for isolated compiled-route tests. Deprecated runtime-env reads are removed from every current consumer.
- Preserve rejection of missing-Origin form submissions, which the new framework otherwise admits. Existing cross-origin checks, secure cookies, Turnstile, JSON approval origin guards and private-media auth remain.
- Explicit `session: false`, `imageService: 'compile'`, `compressHTML: true`. No new SESSION KV or IMAGES binding. No automatic public preview, workers.dev address or route. Same DB, SESSIONS and PHOTOS resource identities.
- Assets binding serves **only `dist/client`**. Server code remains under `dist/server`. Explicit `upload_source_maps=false`.
- Prospective CI uses Node from `.nvmrc`, runs Astro check, production build and both full regression suites, then `wrangler deploy`. It never runs `pages deploy dist` on the Workers build. This workflow has not been pushed or run in GitHub; main's existing Pages workflow is unchanged.

## Versions and dependency security

| Component | Migration version |
|---|---|
| Node | 24.22.2; `.nvmrc` and engine constrained to the 24.x line |
| Astro | 7.4.7 |
| Cloudflare adapter | 14.4.6 |
| Sitemap / Astro check | 3.7.4 / 0.9.12 |
| Wrangler | 4.158.0 |
| Direct Miniflare test harness | 4.20260730.0 |
| Wrangler's current emulator | Miniflare 5.20261104.0-beta / workerd 1.20261104.1 |

Initial upgraded audit left three high dependency nodes, rooted in the old direct Miniflare's pinned Sharp/Undici. Explicit compatible overrides install Sharp **0.35.5** and all Undici 7.x copies at **7.30.2**; Undici 8 used by Astro tooling stays on its own resolved major. These are real installed patches, not advisory exclusions. See [Sharp release](https://github.com/lovell/sharp/releases/tag/v0.35.5) and [Undici security release](https://github.com/nodejs/undici/releases/tag/v7.30.2). No force-fix or audit suppression was used.

Final npm audit: **0 critical, 0 high, 0 moderate, 0 low**. Registry results are time-bound, not a claim of absence of every possible vulnerability. This clears the previously reported dependency-version findings **in the isolated migration**, not the still-Astro-5 production deployment. Miniflare, Wrangler, Vite and Sharp are development/build tools; compiled application paths remain covered by full tests and actual workerd rehearsal.

Node 24.22.2 is not a substitute for the upcoming patches. The [November 11 Node security release](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases) is announced for November 11 or shortly after, with patches not yet published as of this November 8 checkpoint. Follow up after publication: review the 24.x security release, update `.nvmrc`/engine/CI as needed, rebuild and rerun checks. No Node 26 migration or reminder automation was created.

## Final validation

| Check | Result |
|---|---|
| Astro/TypeScript check | 0 errors, 0 warnings, 14 existing hints |
| Production build | Passed |
| Full application suite | **421/421 passed**, no failed/cancelled/skipped tests |
| Full Facebook Worker suite | **1,730/1,730 passed**, no failed/cancelled/skipped tests |
| Site Wrangler dry run | Passed; 1,156.36 KiB / 287.63 KiB gzip, intended DB/KV/R2/ASSETS bindings only |
| Facebook Worker dry run | Passed; 369.00 KiB / 92.16 KiB gzip; source/config unchanged |
| Local actual workerd SSR + bindings | Passed on both direct harness and Wrangler's current emulator |
| Local photo round trip | Real multipart WebP → local R2/D1 → byte-identical HTTP image; passed |
| Auth/CSRF/private media | Public SSR 200, protected staff redirects, authenticated staff pages 200; missing/cross-origin forms 403, private originals 401; passed |
| Static/server separation | Assets served; `/server/entry.mjs` returns 404; generated ASSETS path is client-only |
| Responsive browser smoke | 390px menu has no horizontal overflow; Daily/Late Night switching works; no sampled browser warnings/errors; viewport restored |
| Route precedence and rollback model | Passed with Miniflare's route parser/matcher; live routing unchanged |
| Full diff/line endings | Original unchanged line endings preserved; no unrelated business logic, Worker source or schema changes |

No test was removed. Compiled-route/component/manifest imports were adapted to hashed output. The first application run exposed quote-entity representation assertions (`&#34;` versus equivalent `&quot;`); only those encodings were adapted, preserving selected/unselected checks, save snapshots and stale-write protections. The final complete rerun passed.

Local tests use synthetic schema/data and fake session values; outbound provider services were disabled. Fixture setup was corrected to include existing collection timestamp/section, alert and Wing definitions missing from the standalone schema bootstrap. **No historical migration was replayed in production.** No production-backed public test site was created. Live Turnstile, Resend delivery and production-signed-in mutation flows were not exercised.

## Capacity gate: Workers Free is not cleared

Read-only dashboard inspection of this account's Billing → Subscriptions showed **Workers Free, Active** and the existing separate R2 subscription. The API's `default_usage_model=standard` is **not evidence of a paid Workers subscription**. Subscription API access returned 403; the authenticated dashboard supplied the actual plan evidence. No billing data or payment instrument was changed.

[Cloudflare's current limits/pricing](https://developers.cloudflare.com/workers/platform/pricing/) state 100,000 dynamic Worker requests/day and **10 ms CPU per invocation** for Free. The request allowance is shared across the account; static-asset requests are distinct from dynamic invocations. Current account-wide traffic/headroom was not established. Do not substitute analytics visits for Worker requests.

Measured ten warm requests per route after warm-up using the application isolate's V8 CPU sampler, excluding `(idle)` and reporting `(program)` separately. Repeated once after the full regression load ended, then repeated on **Wrangler's current workerd**. Latest current-runtime estimates:

| Route | Estimated sampled active CPU / request |
|---|---:|
| `/` | 10.33 ms |
| `/menu` | 9.87 ms |
| `/specials` | 7.80 ms |
| `/admin/menu` | 26.21 ms |
| `/admin/specials` | 18.31 ms |
| `/admin/automation` | 11.22 ms |

These are **local sampled estimates**, not provider billing measurements, production percentiles, or a literal proof of edge failure. Synthetic data and local CPU/scheduling differ from Cloudflare; cold requests and larger content may cost more. They do not provide a defensible 10-ms margin, especially for staff editors. Local emulation did not enforce the production Free CPU cap. The required capacity gate is therefore **failed/not established**, and production cutover is stopped.

Two reviewable paths: optimize and remeasure for Free with adequate headroom, or obtain explicit authorization for Workers Paid. Paid currently starts at **$5/month plus usage**, including 10 million requests and 30 million CPU-ms/month; overage is $0.30 per million requests and $0.02 per million CPU-ms. No plan upgrade is authorized by this report. Illustration, not a traffic forecast: 100,000 dynamic requests/month at 50 ms each consume 5 million CPU-ms and fit the base included allowance; existing account usage, R2, D1 and other services must still be counted separately. Actual production cost is not yet forecast because account-wide invocation volume is unverified.

## Exact proposed cutover — NOT EXECUTED

This proposal uses a Worker **route in front of the retained Pages origin**, not a conflicting custom-domain replacement. [Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/) apply in front of proxied origins; [more-specific patterns win](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior).

1. Clear capacity, current account traffic and deployment-token permission gates. Review this exact migration diff/checkpoint. Recheck current Pages and Facebook versions, bindings, routes and remote main; stop on unexpected drift.
2. Only after explicit release authorization, commit/integrate the reviewed branch to main and let the updated CI upload the **unrouted** site Worker `grayzn-buffalo` with `dist/client` assets. No Worker named `grayzn-fb-feed-production` is created. Do not use `pages deploy dist`.
3. Securely copy the **existing values** of Pages secrets to the site Worker: `ADMIN_PASSWORD`, `TURNSTILE_SECRET`, `TURNSTILE_SITEKEY`, `RESEND_API_KEY`, `CONTACT_TO_EMAIL`, `CF_ANALYTICS_API_TOKEN`. Preserve the two analytics plain vars and the same DB/SESSIONS/PHOTOS IDs. This is secret reuse/transfer, not rotation. Values are not recoverable from redacted API metadata; arrange a secure owner-supplied source before release. No secret values belong in Git, logs or this report. CI token's Workers upload scope is not verified merely because it deployed Pages successfully.
4. Add **only** the new site route `grayznbuffalo.com/*` → `grayzn-buffalo`, record its new route ID and active site Worker version, and persist the approved route in the site Wrangler config. Retain Pages custom domain, its DNS record and deployment `d5cfa3ed...` for direct origin fallback. Keep existing www and gumbysbar permanent redirects. No DNS replacement or Pages-domain detachment is planned.
5. Preserve both existing Facebook routes unchanged: `grayznbuffalo.com/api/facebook-feed` → `grayzn-fb-feed`, route ID `14bd08888a614abda5c7205208b13f7f`, and `grayznbuffalo.com/api/facebook-webhook*` → `grayzn-fb-feed`, route ID `2d4408481de04300b715ec83dbd84b2b`. Confirm fresh IDs rather than trusting copied identifiers if they differ from the API checkpoint.
6. Verify public/admin/asset/error/image responses, security/no-store headers, real secret presence, CPU/errors, source routing and a normal automation scan. Authorized production mutation/email testing must be scoped separately; do not silently edit specials or generate alerts.

The route matcher rehearsal covers root, Menu, staff Menu, exact Facebook feed and webhook with/without query. Existing `/api/facebook-feed?x=1` does **not** match its exact current Worker route: production read-only probe returns 404 today. The proposed site Worker likewise has no feed endpoint and keeps 404 for that unsupported query form. Do not silently broaden the dedicated Worker's routes in this migration.

Expected downtime: none intentionally scheduled because the existing Pages origin remains ready; route propagation/transient errors are still possible and cannot be promised away. No production schema/data transformation occurs. This plan remains subject to the failed capacity gate and owner authorization, not an instruction to execute now.

## Rollback preparation and tests

The retained Pages deployment's direct URL `https://d5cfa3ed.grayzn-buffalo.pages.dev/` returns 200. Local route-matcher rehearsal proves removing only the proposed site route returns non-Facebook requests to the existing origin and keeps both Facebook routes selected. Local old/new auth, image and data contracts require no migration reversal. **Live edge cutover/rollback was not rehearsed**, since no new production route is authorized.

After any authorized cutover, roll back on public/admin errors, auth/cache/header regressions, image failures, excessive CPU/1102 responses or changed Facebook routing:

1. Read the exact new site route by its recorded ID in zone `87b96c2cdba55c83e0c20696849ce9cb`. Require pattern `grayznbuffalo.com/*` and script `grayzn-buffalo`; stop if either differs.
2. Remove **only that route** using Cloudflare's route UI or `DELETE /client/v4/zones/87b96c2cdba55c83e0c20696849ce9cb/workers/routes/<recorded-new-site-route-id>`. Never delete either Facebook route or any Worker/database/namespace/bucket/queue. This command is conditional documentation, not executed work.
3. Confirm apex traffic returns to retained Pages `d5cfa3ed...` / commit `dd10dc2`, public/admin/images are healthy and the Facebook Worker is still `eb32d3f0...`. Retain legitimate writes made since cutover; **do not restore D1/KV/R2**. The unrouted site Worker may be retained for diagnosis.
4. Hold future CI uploads/route activation until the approved configuration matches rollback state; do not let a later deployment automatically recreate the removed route. Preserve Pages indefinitely until a separately approved retention decision.

## Outstanding work and resume point

- Do not request or execute routing cutover as though all gates passed. Resolve Free CPU headroom or explicitly approve a paid-plan path first. Confirm account-wide request headroom, CI token scope and secure reuse of existing secrets. Edge CPU and real providers remain production-verification items after any future authorized rollout.
- Audit Q1/Q2/R1/V1, broader E1, A1 and backup/monitoring/WAF evidence gaps remain as recorded in the audit. This migration does not claim that every Medium operational/hardening item is closed. No new production index/migration, auth redesign, backup job, secret rotation, Photos & Reviews feature or final quality audit was started.
- README/architecture/actual-platform deployment documentation is deferred until a successful migration, as requested. This readiness/rollback document and audit update describe the real current split: **production Pages is Astro 5 with released photo fixes; Astro 7 is local and blocked at capacity/release gates**.
- Private/local evidence: migration build/check/full-suite logs, `.wrangler/migration-audit.json`, runtime check, route rehearsal and CPU profiles. Keep those out of commits. Review exact source and lockfile before resuming; preserve October worktrees and main's security release.
