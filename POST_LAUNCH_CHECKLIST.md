# Post-Launch Checklist

## Current Verified State

| Item | Status |
|---|---|
| Production deployment | Live at `grayznbuffalo.com` |
| Worker version | `344d5be3-5203-4165-81f3-5a0d0fbc7949` |
| `SPECIALS_IMPORT_MODE` | `GUARDED_AUTO` |
| Parser version | 16 |
| Workers AI model | `@cf/google/gemma-4-26b-a4b-it` |
| D1 migration `0019` | Applied |
| Worker test suite | 406/406 passing |
| Application test suite | 93/93 passing |
| Astro check | 0 errors, 0 warnings |

## Facebook Specials Automation

- [ ] Verify `GUARDED_AUTO` is running: check `special_imports` for same-day rows with `processing_status='staged'` or `'published'`
- [ ] Confirm Sunday 7 PM week-creation: check `special_collections` for a row with `kind='week'` covering the upcoming Monday
- [ ] Confirm Mexican Night section published on Tuesday: check `special_collections` where `id='mexican-night'` and `section_source='facebook'`
- [ ] Verify 50-call daily budget is not being exceeded: check `special_import_events` for `event_type='extract'` on any single day

## Staff Administration

- [ ] Weekly specials entry and save working
- [ ] Manual lock / unlock working; automation respects locks
- [ ] Admin analytics page loading and returning data
- [ ] Welcome photos upload and display working

## Public Site

- [ ] Specials page shows current week and Mexican Night section (Tuesday–Wednesday)
- [ ] Homepage shows today's specials when present
- [ ] Facebook feed cards loading from cached endpoint
- [ ] Contact form delivering to configured recipient
- [ ] Sitemap accessible at `/sitemap-index.xml`

## Security

- [ ] Admin routes require authentication; unauthenticated requests redirect
- [ ] CSP remains Report-Only (Cloudflare JS Detections injects inline scripts at edge)
- [ ] No secrets committed to repository

## Maintenance backlog — added October 25, 2026

These are follow-up tasks, not authorization to change dependencies, production resources or Git history. Historical verified-state numbers above have not been refreshed by this documentation task.

- [ ] **High priority — patched Node runtime verification/update.** Local Node is v24.19.0, older than the [24.22.1 security release](https://nodejs.org/en/blog/release/v24.22.1). Inventory actual Node executables used by developer shells, Codex, tests/builds and CI; verify a supported patched release (24.22.1 or a later reviewed patched 24.x release; the 22.x CI line needs its own patched version). CI currently requests major 22 through setup-node; that declaration alone is not evidence of the version a past job used. In a separate authorized maintenance task, update/pin appropriate runtimes, record provenance and rerun Worker/application tests, build/check and dry run. Do not assume a runtime update fixes the local path issue or changes Cloudflare's workerd runtime.
- [ ] **Immediate process change — D1 seven-day undelete and backup policy.** Treat accidental database deletion as an immediate recovery incident: record database/account identity and deletion UTC, notify the owner immediately, and obtain recovery authorization promptly. An undelete request must be made within 7 × 24 hours; do not plan to wait until day seven. This [undelete limit](https://developers.cloudflare.com/changelog/post/2026-10-23-undelete-seven-day-window/) is distinct from [Time Travel's plan-dependent history](https://developers.cloudflare.com/d1/reference/time-travel/). Before destructive database work or migrations, require explicit approval, a reviewed recovery plan, a sufficiently fresh encrypted access-restricted backup, recorded identity/size/hash and verified isolated restore/data preservation. Define owner, retention and periodic restore-test cadence before automating backups; no backup schedule or extra export is authorized here. Preserve the verified alerts backup until an approved retention decision. Never treat undelete or Time Travel as a substitute for independently verified recovery evidence.
- [ ] **Next Worker deployment — Wrangler 4.150+ source-map review.** Installed Wrangler is 4.148.0. [4.150.0 release notes](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.150.0) change deploy/versions-upload/preview to upload source maps by default when unspecified. Before any authorized upgrade/deployment, review the chosen version, generated maps/source contents, access/privacy and diagnostics requirements; choose and document explicit upload_source_maps policy and inspect the dry-run artifact. No setting or dependency was changed here; do not silently inherit a new upload policy.
- [ ] **Planned maintenance — Astro major-version upgrade.** Installed Astro is 5.18.2. Plan a separate branch/task to select a supported target and review its migration guide, Cloudflare adapter/runtime compatibility, breaking changes and lockfile diff. Validate SSR/auth/admin, D1 access, public specials/feed pages, build/check and application regressions before any release. Preserve rollback artifacts; do not combine with the alerts rollout or October incident fixes.
- [ ] **Final maintenance — Git branch/worktree cleanup.** After reviewed integration and retention decisions, inventory branches/worktrees, dirty files, untracked/ignored artifacts and unmerged commits. Identify the owner and recoverable checkpoint for each. Obtain explicit authorization for every deletion/archive; preserve the alerts commit, private backup and diagnostic evidence. Do not delete or merge branches as part of the current task.

See [latest alerts readiness and handoff](docs/facebook-alerts-production-readiness.md) for production gates. Backlog items remain open; the D1 recovery process requirements above take effect for future planning immediately.

## References

- [Facebook Specials Automation](docs/facebook-specials-auto.md)
- [Mexican Night Automation](docs/MEXICAN_NIGHT_AUTOMATION.md)
