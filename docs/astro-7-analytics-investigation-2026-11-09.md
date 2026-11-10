# Astro 7 analytics investigation — November 9, 2026

**Status: root cause unconfirmed; no commit, push, CI deployment or production cutover.**

The user's stop condition applies: do not deploy an unverified correction. The
local changes improve failure diagnostics only; they do not claim to fix Stage 2.

## Evidence

- Fetched origin before modifications. Main, origin/main and the clean migration
  worktree started at `59e361cf107289e3a6f2306b8dfb4017f112733c`.
- Read release preparation, independent review, readiness report and retained
  Stage 2 evidence under the migration worktree's ignored `.wrangler/` directory.
- `git diff dd10dc2 HEAD -- src/lib/analytics.ts` is empty. The working Pages and
  Astro 7 versions have identical analytics endpoint, bearer header, queries,
  filters, chunking, timeout, response validation and normalization. The admin
  page changed only its binding accessor to `runtimeEnv(Astro.locals)`.
- Settings run first, then contiguous history chunks sequentially, then one
  combined recent pages/sources query. Daily visits are derived from historical
  hourly rows. There is no provider retry. Only the independent D1 click read runs
  concurrently with the analytics loader. There is no per-dashboard timeout.
- Each GraphQL request uses `AbortSignal.timeout(12_000)`, covering fetch/body
  consumption. This is an application wall-clock timeout, not a Workers CPU limit.
  Its presence does not prove it fired during Stage 2.
- The Stage 2 metrics report 47 requests, zero runtime errors, 6.592 ms CPU p50 and
  93.546 ms CPU p99. These aggregate observations do not identify the failing
  analytics invocation, and a handled provider failure need not appear as a
  runtime error. There is no confirmed CPU-limit diagnosis.
- No captured `analytics_failure` event was found in the retained Stage 2 files.
  The signed-in Worker dashboard explicitly reports **Workers Observability is
  Disabled**. No persisted Stage 2 application log was available through this
  investigation. The telemetry API query with local Wrangler OAuth returned 403;
  that is a log-access result, not an analytics-provider result.
- The initial control-plane queries returned 401 because the locally retained
  Wrangler OAuth session needed refreshing. `wrangler whoami` refreshed it and
  subsequent configuration reads returned 200. This credential is separate from
  `CF_ANALYTICS_API_TOKEN` and is not evidence about the analytics secret.
- Fresh configuration checks confirm six secret names, both analytics plain vars
  matching source, active Worker version
  `651dfed3-8fd3-4ea7-94e1-d2d0facccc7b` at 100%, no site route, and disabled
  workers.dev/previews. Both existing Facebook routes remain present. The
  names-only secret guard passes. Secret contents were not read or displayed.
- The existing authenticated Pages analytics tab displays November 9 data:
  1,220 recent visits, 3,300 historical visits, 20 Facebook clicks, populated
  pages/sources and working month controls. This is the visible Pages baseline,
  not a simultaneous comparison with the unrouted Worker.
- Before changing source, the compiled analytics loader returned `ok` in actual
  local workerd using fake credentials and mocked Cloudflare GraphQL responses.
  This tests runtime compatibility; it does not validate deployed credentials,
  real GraphQL schema/data, latency or Workers-to-provider network behavior.

## Local diagnostic changes

`src/lib/analytics.ts` adds failure phase (`fetch`, `json`, `validate`, `normalize`),
total elapsed milliseconds, current-query elapsed milliseconds, and retains the
HTTP status when JSON/body parsing fails. The existing stage, history chunk,
validated limits and fixed GraphQL categories remain. HTTP status resets before
each request, avoiding attribution of a previous successful response to a later
network failure. No raw error, provider response, credential, cookie, query
variables, path, source hostname or visitor data is logged.

`tests/analytics-diagnostics.test.mjs` adds nine cases (four parent tests and five
subtests) covering fetch/body timeout distinctions, non-JSON HTTP failures,
GraphQL schema category, access denial, history chunk and elapsed timing, recent
query isolation, normalization, privacy, and a failing diagnostic sink. These are
diagnostic regressions, not a reproduction of the unknown Stage 2 cause.

Queries, timeouts, authentication, safe public errors, no-store headers, chart
navigation, rate limits, D1 click handling, Menu, Specials, contact forms, images,
CI safeguards and Facebook automation remain unchanged. All changes are confined
to the migration worktree; main remains clean.

## Verification

| Check | Final result |
|---|---|
| Analytics-specific tests (including new diagnostic cases) | 27/27 passed; included in focused 31/31 run |
| Full application suite | 446/446 passed; zero failures, skips or cancellations; 251.34 seconds |
| Deployment configuration and secret-guard tests | 9/9 passed |
| Live names-only secret guard | Six required secrets present; no vars collisions |
| Astro/TypeScript check | Zero errors, zero warnings, 14 existing hints |
| Production build | Passed |
| Wrangler deployment dry run | Passed; 1,156.75 KiB / 287.79 KiB gzip; no upload |
| Local workerd analytics loader, before source changes | `ok`, mocked provider, fake credentials |
| Local compiled-site workerd rehearsal after changes | Passed: authenticated analytics renders synthetic seven-visit metrics, calendar controls and sources; public routes, anonymous/authenticated admin behavior, CSRF denial, disposable local image round trip, private images and server bundle isolation |
| Read-only production health | Home/Menu/Specials/Contact/login 200; anonymous analytics 302 with no-store; Facebook feed 200; unauthenticated webhook 403; server bundle 404 |
| Preservation review | No changes to pages/components, middleware, CI/config, production storage or Facebook Worker; main clean; `git diff --check` passed |

Production Pages still resolves to deployment
`d5cfa3ed-5538-4d93-a59b-1d8fa330fa23`, commit `dd10dc2`. Facebook still runs
`eb32d3f0-f0bc-47a9-9b92-21282c359dfd` at 100%. The separate 1,730-case Facebook
Worker suite was not rerun: its source/configuration did not change and no CI
deployment was attempted. Application tests do cover shared Facebook behavior.

Ignored local evidence: `.wrangler/analytics-{investigation-control,public-health,rehearsal}.json`,
`analytics-{focused,full-tests,deploy-guards,check,build,dryrun,runtime}.log`, and
the local probe scripts. Existing Stage 1/2 artifacts were preserved.

## Release decision and remaining evidence gap

**Not ready for another production cutover.** There is no verified application
correction to commit or deploy. No CI run was triggered and the Worker version
above was not changed. DNS, routes, Pages, credentials, production D1/KV/R2 and
Facebook automation were not modified. No production contact form was submitted.

The remaining requirement is a private, authenticated invocation of the deployed
Worker with a live sanitized log capture, using its existing bindings and actual
analytics credential. The current deployment has no route, workers.dev or preview
URL, and persisted logs are disabled. This investigation did not enable any of
those facilities or upload diagnostic code in violation of the verified-fix-only
deployment restriction. A separately scoped diagnostic rehearsal must establish
which query/phase fails before changing credentials, timeout, query complexity or
runtime configuration. Neither secret-name presence nor mocked runtime success
can establish that evidence.
