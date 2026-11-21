# Maintenance and security hardening — November 21, 2026

The November 21 maintenance release was deployed and verified. The [release record](#verified-production-release)
contains the deployed versions, CI results, and post-release restore checks. Finding IDs (Q1, R1, …) refer to
`security-reliability-audit-2026-11-08.md`.

## Pre-release baseline

- `main` = `origin/main` = `c59dbfb` (freshly fetched), clean tree. Older worktrees preserved, untouched.
- Latest CI run (44853011365, `c59dbfb`) green. One earlier failure (43670451302, `cd92e08`) was superseded by green runs.
- Site Worker `grayzn-buffalo` version `64d70f39-5828-405f-9366-1af996738dcb` (100%, Nov 21 02:05 UTC). Live `/_astro/*`
  asset hashes are byte-identical to a local Astro 7.4.7 build of HEAD.
- Facebook Worker `grayzn-fb-feed` version `30d3ef42-01b5-4650-9b5a-549b655c6670` (Nov 21 01:47 UTC). Its private
  release manifest (128 files) matches HEAD byte-for-byte.
- Node 24.22.3 locally and in `.nvmrc`. `npm audit`: 0 findings at every severity.
- Live headers: HSTS, nosniff, `X-Frame-Options: DENY`, Referrer/Permissions-Policy, CSP **Report-Only** (unchanged, intentional).
- Baseline before changes: `astro check` 0 errors/0 warnings; build OK; app 482/482; Worker 1,826/1,826.

## Changes shipped in the maintenance release

| Finding | Change | Files |
|---|---|---|
| R1 request bodies | Bounded body reader (stops at a byte limit with or without an honest `Content-Length`). Public: contact JSON 32 KiB, Facebook click 64 B, sign-in/settings form 16 KiB. Staff: Menu/Specials forms 512 KiB, Wing approval 16 KB, photo uploads 2 × 10 MiB + 64 KiB. Oversized → 413 before parsing, R2 or D1. | `src/lib/request-body.ts` (new), `api/contact.ts`, `api/facebook-click.ts`, `api/menu-photo.ts`, `api/welcome-photo.ts`, `admin/index.astro`, `admin/menu.astro`, `admin/specials.astro`, `admin/automation/wing.ts` |
| R1 remote fetches | Graph scan and feed requests time out after 15 s; Facebook image fetches after 20 s. A timeout is a transient failure, so the scan stays incomplete and nothing is published. Import images are read with a streamed 10 MiB cap and are no longer buffered whole before the size check. Feed images without a declared length are buffered with the same cap. | `workers/fb-feed/worker.js` |
| V1 input limits | Menu item name 1–120 and description ≤1,000 characters server-side, with matching `maxlength` (existing max: 31/178). An empty name is rejected; previously a missing name could be stored as `"null"`. Announcements ≤140 characters server-side (matches `maxlength`), saved in one D1 batch instead of three independent writes. | `admin/menu.astro`, `admin/index.astro` |
| E1 staff errors | Admin Menu and Specials no longer reflect raw exception text. Validation and conflict messages are kept; D1/SQL/constraint/runtime (`TypeError` etc.) messages become a generic message. Same rule as the approval/dismissal/Wing endpoints. | `src/lib/staff-error.ts` (new), `admin/menu.astro`, `admin/specials.astro` |
| Q1 queries | Public and staff event readers no longer `SELECT *`. They skip `evidence_json`/`last_auto_json` (kilobytes per event) and `mutation_token`, and fall back cleanly if `display_from` (migration 0028) is absent. Menu readers list their columns. Ordering, the 50-event bound and all editor data are unchanged. | `src/lib/special-events.ts`, `src/lib/db.ts`, `admin/menu.astro` |
| CI least privilege | Removed unused `deployments: write` (wrangler-action gets no GitHub token). Pinned `actions/checkout`, `actions/setup-node` and `cloudflare/wrangler-action` to the commit SHAs their current `v5`/`v5`/`v4` tags resolve to. `persist-credentials: false` on checkout (no step uses git credentials). | `.github/workflows/deploy.yaml` |

Regression tests: `tests/maintenance-hardening.test.mjs` (9) and `workers/fb-feed/fetch-bounds.test.js` (4). They
cover endless/dishonest bodies, providers/D1/R2 never touched on rejection, boundary values that still save, error
sanitization, events with 25 KB of stored evidence, the pre-0028 schema, stalled CDN with transient retry and later
recovery, stalled Graph scan with no import or publication, and an endless image body with no AI call.

## Deliberately not changed

- **Q2 alert snapshot/fence.** Not safely scopable to the current week. `alert-runtime.js` resolves weekly-lunch slots
  by the week an inspection targets (`lunchSlot(r.weekId, …)`), which can differ from the scan day's week. A
  current-week filter would make `dailyPublished` false and raise false `retained_conflict` alerts. The snapshot and
  `alertEvidenceFence` must keep identical predicates. Size at Nov 15: 345 groups / 1,380 slots, growing about one week per week.
  A safe design must first collect the referenced week IDs, then fence exactly that set.
- **Saved-week list (Admin Specials) and staff menu list.** Unbounded but small (4 short columns, about 52 rows a year; 115
  items the editor must show in full). Capping them would hide archived weeks or truncate the editor, so I left them alone.
- **A1 sessions.** No change. 24-hour KV TTL, fresh token at login, logout deletes key and cookie. KV is eventually
  consistent, so revocation in other locations can lag. Password rotation does not end existing sessions. A
  fix (bind sessions to a password-derived generation) is an auth change requiring approval.
- **CSP.** Remains Report-Only; no `script-src` change.

## Pre-release recovery baseline

- **Restored and verified locally (D1 runtime):** the Nov 15 02:54 UTC pre-deploy export (993,627 bytes, SHA-256
  `69c5dc52…6281288`) restored into an empty, isolated workerd D1 (Miniflare, throwaway database name, private folder):
  2,700 statements in one batch, all 23 tables' row counts equal the export, `quick_check` ok, 0 foreign-key
  violations, 27 indexes, 29 migration receipts. The application menu and event readers (including the new explicit
  columns) ran against the restored schema. This is a local D1-runtime rehearsal, not a restore into Cloudflare D1.
  D1 rejects `PRAGMA integrity_check` (`SQLITE_AUTH`). Use `quick_check` there, or `integrity_check` in plain SQLite
  (also ok).
- **Backup inventory at the start of the review:** the newest local export was from Nov 15. The private path
  named in the Oct 25 record was no longer present. The Nov 21 exports and verified off-computer copy are
  recorded below.
- **R2 at the start of the review:** there was no independent R2 copy. The Nov 21 copy covers the referenced
  menu and welcome photo objects listed below. D1 Time Travel does not cover R2.
- **Stale menu baseline:** `src/data/menu-baseline.json` (Sep 7) differs from the Nov 15 export in 81 of 113 items
  (mostly November capitalization), lacks 2 items and differs in 1 category. The emergency fallback would show
  outdated text. Refresh per `recovery/README.md` after owner review.

### Verified November 21 pre-release backups

- **D1:** `wrangler d1 export grayzn-db --remote` at 16:57 UTC, 1,002,932 bytes, SHA-256 `f3954afe…15eaa1bc`, stored in
  the private local backup folder (outside every repository and deploy directory). Restore rehearsal into an empty
  local workerd D1: 2,807 statements, 23 tables with row counts equal to the export, `quick_check` ok, 0 foreign-key
  violations, 27 indexes, 29 migration receipts; menu (10 categories, 114 active items) and event readers ok.
- **R2:** all 10 `menu/` and `welcome/` objects referenced by that export plus their 10 `@600` thumbnails (20 objects,
  814,276 bytes) downloaded with `wrangler r2 object get --remote`. Each file's MD5 equals the live R2 ETag and its
  SHA-256 equals the bytes served by `/img/<key>`: 20/20. The archive and saved manifest match all 20 local
  files. Unreferenced objects and `facebook/` images were outside this backup. Re-fetching Facebook images
  depends on continued access to the source. A full bucket inventory remains unverified.
- **Off-computer copy (verified):** two GnuPG AES-256 archives (D1 export; 20 R2 objects with manifest) in a private
  Google Drive folder with inherited permissions disabled (owner-only access confirmed on folder and files).
  Archive SHA-256: D1 `53f12942…8dd92699` (88,371 bytes), R2 `561042f9…9d0dd6a5` (819,235 bytes). Both were
  re-downloaded, matched these checksums, decrypted and reproduced the original export and all 20 objects.
  The offsite D1 archive is the pre-release snapshot. The separately verified post-release D1 export is
  recorded in the release record below.

## Remaining verification

During the code pass, remote D1 reads, `wrangler d1 execute` (even `--local` against the production name) and dry-run
deploys were blocked by the session's permission policy; the later authorized export and R2 downloads succeeded. Earlier records still apply: WAF/rate-limit rules, TLS mode, DNS origin targets,
bot settings and API-token scopes returned HTTP 403 and still require read-only dashboard review. Completing
the R2 inventory and agreeing backup ownership and retention are separate follow-ups.

## Verified production release

- **Source and CI.** Commit `a3f4d1366c4a0d9d17f9a2637a98a52525d61213` on `main`.
  [GitHub Actions run 44936454618](https://github.com/joshua-werlein/grayzn-buffalo/actions/runs/44936454618)
  succeeded, including Astro checks, the production build, 491 application regressions, 1,830 local and mocked
  Facebook Worker regressions, and the site deploy. The local npm audit reported zero findings.
- **Site Worker.** `grayzn-buffalo` version `8f36fba6-e379-408a-9a03-9db3157026af` deployed at
  12:46 p.m. Central and served 100% of traffic, matching CI. Public pages loaded, staff pages redirected unauthenticated requests to sign-in,
  photo APIs rejected unauthenticated requests, and the contact API returned HTTP 413 for an oversized request.
- **Facebook Worker.** `grayzn-fb-feed` version `509cda22-b3d0-42a2-8b0c-a49518e0342e` served
  100% of traffic after deployment at 12:52 p.m. Central. Wrangler registered the existing feed and webhook routes,
  30-minute cron, and producer and consumer for `grayzn-fb-import-trigger`. The deployment retained `FB_KV`,
  `IMPORT_TRIGGER`, `DB`, `PHOTOS`, and `AI`. The public feed returned HTTP 200 and the unauthenticated
  webhook GET returned HTTP 403. Verification did not trigger imports or edit specials. The site version stayed unchanged.
- **Post-release D1 export and restore.** A read-only export of `grayzn-db` at 12:54 p.m. Central was saved
  in a new owner-only local backup directory outside the repository. It is 1,002,932 bytes with SHA-256
  `c2fdd9e3736b462e9a5f64dc9847c32a11b1d2564807be9eca56e6d9f671e80e`. The isolated workerd D1 restore
  loaded 2,807 statements. All 23 table row counts matched, `quick_check` returned `ok`, and the restore reported
  zero foreign-key violations, 27 indexes, and 29 migration receipts. Application readers returned 10 menu
  categories and 114 active items and exercised the event reader successfully. The earlier encrypted D1 and R2
  archives remain separate recovery points.

The pre-release versions recorded for rollback were `109562c4-4494-4ecb-8c61-65aade0895f8` for the site
Worker and `30d3ef42-01b5-4650-9b5a-549b655c6670` for the Facebook Worker.
