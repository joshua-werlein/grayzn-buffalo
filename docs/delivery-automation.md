# Delivery banner automation

Prepared against fetched `origin/main` / local `main` at `121a011` on October 13, 2026. No production deployment or remote database changes have been made.

## Claude Code handoff: start here

Use the same repository at `C:\Users\Jwerl\dev\Grayzn Buffalo` (remote `https://github.com/joshua-werlein/grayzn-buffalo.git`). The local handoff branch is `codex/delivery-automation`, based on `121a011`. Its handoff commit is titled `feat: automate delivery banner visibility with handoff`. Obtain its exact SHA with `git log -1 --format=fuller`; do not assume the branch has been pushed. All ten task files below belong in that commit. No unrelated working changes were present when preparing this handoff.

The user's October 13 handoff request explicitly authorizes this local feature branch and commit, overriding the older no-commit/no-branch instruction in `CLAUDE.md` for this checkpoint only. It does **not** authorize pushing, merging, remote D1 migrations, Pages deployment, Worker deployment, or production settings changes. Stop for explicit user approval before those actions. Do not infer deployment permission from these written commands.

Resume with read-only checks:

```powershell
Set-Location 'C:\Users\Jwerl\dev\Grayzn Buffalo'
git status --short
git branch --show-current
git log -1 --format=fuller
git show --stat HEAD
git diff 121a011...HEAD -- src workers migrations docs/delivery-automation.md
Get-Content docs/delivery-automation.md
```

Preserve any changes made after this checkpoint; do not reset or clean the repository. Claude can work directly in this checkout without copying files, creating another worktree, or reconstructing this conversation. The local commit preserves source, tests, migration and this handoff; ignored test logs and build output also remain on disk in this same checkout, but are not part of the commit.

### Completed

- Implementation, additive migration file, focused tests, code/diff review, and rollout/rollback documentation.
- Inspected current `worker.js`, extraction, reconciliation/guarded publication, worker configuration, layout, admin settings, D1 schema and relevant tests rather than relying on older handoff documents.
- Confirmed the initial tree contained only this task's four modified and six untracked files. No specials mapping, recurring defaults, Mexican Night behavior, cron configuration, or unrelated styles were changed.

### Tested

- Worker suite 974/974; application suite 126/126; focused delivery tests 23/23, including real temporary local D1.
- Final production build, Worker bundle dry run, and diff whitespace check passed. Details and reproducible commands are below.
- This handoff update changes documentation only; it does not invalidate those implementation test results. Re-run relevant checks if source changes after resuming.

### Pending — not authorized or performed

- Human review and approval of production rollout, including the explicit Automatic opt-in and limitations below.
- Push/merge, remote migration 0022, Pages deployment, Worker deployment, and any production setting changes.
- Capture current production deployment/version IDs and the staff setting before rollout; these values have not been read or guessed for this handoff.
- Live model/poster validation and post-deployment observation of activation and the 3 PM cutoff. Mocked tests do not establish real-image extraction accuracy.

## Cause and behavior

The layout previously defaulted `delivery_display` to `available` and rendered it without a date or time check. The image pipeline did not extract delivery evidence.

Daily poster extraction now includes a separate delivery status, complete verbatim notice, date evidence, and uncertainties in the existing AI request. The specials validators and mappings are unchanged. Weekly and Mexican Night response shapes are unchanged. Only explicit affirmative wording from an eligible, validated, current-day image can activate automatic delivery. Conditional wording, cancellation, conflicting readings, pending sources, staff-reviewed exclusions, wrong parser versions, and older source versions cannot enable it. Cancellation or ambiguity in an eligible source withholds availability across the scan. No delivery mention alone does not enable it; another confirmed poster from the same day can still qualify.

The singleton `delivery_automation` row holds the Chicago day, active flag, exact 3 PM deadline, scan timestamp and source IDs. Snapshot checks protect against concurrent source edits and staff review. Older scans cannot replace newer decisions. The existing half-hour cron expires the row even when imports are OFF or outside their processing hours. The server checks the local day, weekday and deadline on each render and sends `Cache-Control: no-store`, so delayed cron execution cannot expose an expired automatic notice on a new page request. A page already open is not live-updated.

Website text is fixed: **Delivery M–F 11 AM–1:30 PM, within Mondovi city limits.**

## Manual precedence and rollout choice

The existing Available, Unavailable and Hidden settings remain persistent staff overrides, including after 3 PM. Automation never writes `settings.delivery_display`. A new Automatic option uses the expiring evidence; absent settings default to Automatic and hidden without evidence. Unknown setting values fail closed.

**Existing saved settings are preserved.** Migration 0010 initialized some sites to Available without recording whether staff later chose it. There is no safe way to distinguish those defaults from intentional overrides. After approval, select **Automatic — follow today's poster** in Staff Settings to opt this existing site into automation. The migration does not silently reset any existing choice.

Parser identities remain 18/19: the change is an additive, independently validated field in raw extraction JSON, not a change to specials interpretation. Existing staged rows without delivery evidence remain ineligible for automatic delivery. They are not re-extracted or replayed merely because of deployment. New or genuinely edited posts use the extended request. This avoids extra AI calls and special-slot rewrites during rollout. Therefore a poster already processed before deployment may not activate delivery that day.

## Known limitations for review

- Already-processed posters without the new evidence field do not become eligible automatically, including the October 13 poster if it was processed before rollout. No backfill or forced AI replay is implemented.
- Detection intentionally accepts a narrow affirmative sentence beginning with “Delivery [is] available,” with optional “today,” city-limit qualifier and the known lunch window. Other affirmative phrasing can remain hidden for safety. A matching printed weekday in the extracted day/heading/delivery evidence is required; posting time alone cannot enable it.
- Only daily poster extraction supplies delivery evidence. Weekly schedules and recurring Mexican Night menus do not enable it. No live October 13 image/model call was made during this task.
- Current manual Available stays visible past 3 PM by design, because staff overrides win. The 3 PM deadline applies to Automatic. Existing installations must deliberately opt in; older migrations may have initialized the manual value to Available.
- Server rendering and no-store headers protect subsequent requests; an already-open page is not updated by a client timer. Banner visibility does not track the 1:30 PM service-end time; the requested expiration is 3 PM.
- Missing database/table access hides the automatic notice; delivery storage failures do not abort the specials pipeline. Production rollout and observation remain necessary to validate deployed bindings and live extraction.

## Exact files

| File | Change |
| --- | --- |
| `migrations/0022_delivery_automation.sql` | Create separate temporary automation table; no setting or specials data changes. |
| `src/lib/delivery.js` | Shared Chicago deadline, fixed copy, manual precedence, safe state read. |
| `src/layouts/Base.astro` | Resolve visibility at render time; restore the existing hours/qualifier spans so mobile wraps cleanly. |
| `src/pages/specials.astro` | Resolve the specials-page delivery block through the same shared resolver (follow-up fix). |
| `src/middleware.ts` | Send `Cache-Control: no-store` on HTML without an explicit cache policy (follow-up fix). |
| `src/pages/admin/index.astro` | Add Automatic while retaining all three staff choices. |
| `workers/fb-feed/delivery.js` | Validate evidence, expire state, reconcile current source snapshots. |
| `workers/fb-feed/extraction.js` | Add delivery evidence to daily AI schemas/prompts only. |
| `workers/fb-feed/worker.js` | Wire expiration/reconciliation; fence conflicting delivery readings without altering raw AI audit output. |
| `workers/fb-feed/delivery.test.js` | Focused behavior and pipeline regression tests. |
| `workers/fb-feed/delivery-d1.test.js` | Actual local D1 SQL integration test. |
| `docs/delivery-automation.md` | This implementation, validation and rollout record. |

`reconcile.js`, `guarded-auto.js`, recurring defaults, other announcements, CSS and `wrangler.toml` are unchanged. Cron remains `*/30 * * * *`.

## Validation

All Facebook and AI calls in tests are mocked; the D1 integration test uses a temporary local Cloudflare runtime. No live model evaluation was performed. The positive wording test uses the supplied October 13 text; image-reading accuracy remains dependent on the existing model.

Commands:

```powershell
node --test workers/fb-feed/delivery.test.js workers/fb-feed/delivery-d1.test.js
node --test --test-concurrency=4 workers/fb-feed/*.test.js
node --test --test-concurrency=4 tests/*.test.mjs
npm run build
npx wrangler deploy --dry-run --config workers/fb-feed/wrangler.toml --outdir .wrangler/delivery-dryrun
```

Full Worker suite: **974/974 passed**, including all existing specials regressions and the **23/23 focused delivery tests** (also run separately after the final audit/cutoff adjustment). Application suite: **126/126 passed**. Production build, Worker dry-run bundle and `git diff --check`: **passed**. No tests skipped in either full suite.

Logs are local ignored files under `.wrangler/delivery-*.log`. Initial sandboxed D1/runtime tests were blocked by localhost EACCES, and the first sandboxed build failed with EPERM resolving an installed dependency; they were rerun with local runtime access. The first focused run had one incorrect expected Wing Night string in the new test; correcting it to the existing canonical formatter resolved the failure.

Authoritative successful logs: `.wrangler/delivery-worker-tests-unrestricted.log`, `.wrangler/delivery-app-tests-unrestricted.log`, `.wrangler/delivery-focused-tests.log`, `.wrangler/delivery-build.log`, and `.wrangler/delivery-dryrun.log`. The earlier sandboxed `delivery-worker-tests.log` and `delivery-app-tests.log` retain the permission failures and are not the final results. Focused tests were rerun after the final audit-preservation/write-cutoff adjustment; the full worker suite was running across that adjustment. If an exact single-revision full-suite rerun is required by release policy, run the full commands above on the handoff commit before rollout.

## Follow-up verification (Claude Code, October 13, 2026)

Re-ran on handoff commit `9a88811` before changes: Worker 974/974, application 126/126. Three gaps were found and fixed as uncommitted changes on top of that commit:

1. **`/specials` ignored Automatic.** `src/pages/specials.astro` read `delivery_display` directly and treated any value other than `hidden`/`unavailable` as available, so after opting in to `auto` its delivery block would have shown permanently (weekends, after 3 PM, without evidence). It now uses `readAutomaticDelivery` + `resolveDeliveryDisplay`. A source-level test in `delivery.test.js` guards both public consumers.
2. **`no-store` was never sent.** `Astro.response.headers.set` in a layout has no effect because streamed HTML commits headers before the layout renders (verified against the dev server). The header now comes from `src/middleware.ts` for HTML responses that set no other cache policy; `/menu.json` keeps its 5-minute cache and admin remains `no-store`.
3. **Banner wrapping.** The plain `<span>` dropped the existing `.dmain`/`.qualifier` styling. The banner again uses those spans (identical desktop text via the existing `", "` pseudo-element; the qualifier stacks on phones). `DELIVERY_TEXT` is unchanged and is composed from `DELIVERY_HOURS` and `DELIVERY_AREA`.

After the fixes: Worker 975/975 (24/24 focused delivery), application 126/126, `npm run build` and `git diff --check` passed. The Worker dry-run bundle was not re-run in this session; the only Worker-reachable change is the constant split in `src/lib/delivery.js`, which the full Worker suite imports.

## Migration 0022 requirements

`migrations/0022_delivery_automation.sql` creates only `delivery_automation`, using `CREATE TABLE IF NOT EXISTS`. Columns are singleton `id=1`, Chicago `day`, boolean integer `active`, UTC ISO `expires_at`, UTC ISO scan `observed_at`, and JSON `source_ids`. It inserts no rows, changes no settings, and does not modify specials or import tables. Empty state means no automatic notice.

The target is the existing shared Pages/Worker D1 database `grayzn-db`, ID `c998bfd4-7031-4ae2-9eea-df86f16ddb15`, as configured in both Wrangler files. Existing application/import migrations through 0021 are prerequisites; verify their existing production schema rather than replaying them. Apply this file once to the shared database **before deploying either consumer**. No production application has occurred. The new table was created only in disposable test databases. If the table is absent, website reads fail closed and worker delivery errors are isolated from specials processing, but that fallback is not a substitute for applying the migration.

## Production steps — approval required

All commands in this section are future instructions, not commands already run. Required order: approval and rollback records → migration → Pages → Worker → deliberate Automatic opt-in → observation.

1. Obtain explicit rollout approval. Record the current production Pages deployment ID, `grayzn-fb-feed` Worker version/deployment ID, and exact saved `settings.delivery_display` value (including whether absent). Review the local handoff commit. The repository's `.github/workflows/deploy.yaml` triggers production Pages deployment on **push to main**; do not push main before the migration is complete.
2. Apply only the additive migration to `grayzn-db` after explicit approval (do not replay older migrations):

   ```powershell
   npx wrangler d1 execute grayzn-db --remote --file migrations/0022_delivery_automation.sql --config wrangler.toml
   ```

3. Verify the table before proceeding:

   ```powershell
   npx wrangler d1 execute grayzn-db --remote --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_automation';" --config wrangler.toml
   ```

4. Publish Pages through the existing release workflow after an approved human merge of the reviewed feature commit into local `main`. The release operator's push command is below; do not run it from an unreviewed branch or merge automatically:

   ```powershell
   git push origin main
   ```

   Wait for the `Deploy to Cloudflare Pages` GitHub Actions job to succeed. Its exact build/deployment commands (verified in `.github/workflows/deploy.yaml`) are:

   ```powershell
   npm ci
   npm run build
   npx wrangler pages deploy dist --project-name=grayzn-buffalo
   ```

   These commands describe what CI runs; do not additionally deploy Pages locally. If the user instead explicitly approves a manual release, use `npm run build` followed by `npx wrangler pages deploy dist --project-name=grayzn-buffalo --branch=main` from the reviewed checkout, and do not also trigger the CI release. A push to the feature branch alone is not the production Pages workflow.

5. After Pages succeeds, deploy the Worker from the same reviewed revision with existing environment values preserved:

   ```powershell
   npx wrangler deploy --config workers/fb-feed/wrangler.toml --keep-vars
   ```

6. With explicit approval to change production settings, sign into `https://grayznbuffalo.com/admin?settings=1`, select **Automatic — follow today's poster**, and save. Available/Unavailable/Hidden keep overriding automation until changed. Confirm no-evidence rendering is hidden, other announcements are intact, and a subsequent qualifying weekday poster enables the fixed notice. Do not reset completed imports just to backfill delivery.
7. Read state and compare source import evidence as needed:

   ```powershell
   npx wrangler d1 execute grayzn-db --remote --command "SELECT * FROM delivery_automation;" --config wrangler.toml
   ```

   Verify disappearance on a new page request at 3 PM Chicago and the next cron's `active=0` state. Compare specials and Mexican Night with their pre-release values. No cron or queue configuration change is needed.

## Rollback

For an immediate operational stop, select Hidden in Staff Settings; automation cannot override it. For a full rollback, restore the recorded Worker version and Pages deployment using their normal rollback controls. **Before restoring old Pages code, change Automatic to Hidden or another intentional legacy choice:** the old layout treats unknown `auto` as Available. Restore the pre-release staff choice only if that is the intended behavior.

Rollback order after authorization: (1) save Hidden with the new admin UI, (2) use Cloudflare's `grayzn-fb-feed` deployment history to roll back to the recorded pre-release Worker version, (3) use the `grayzn-buffalo` Pages deployment history to roll back to the recorded pre-release production deployment, (4) verify the public site and the deliberate staff choice, and (5) coordinate a reviewed source revert before any later push to main can redeploy this feature. Do not guess rollback version IDs or revert unrelated work. An operational Hidden override alone is sufficient to stop the automatic banner without rolling back code.

Leave the additive table in place; old code ignores it. No destructive schema rollback is required. Do not reset parser versions, replay historical imports, change specials rows, or drop the table as part of routine rollback.
