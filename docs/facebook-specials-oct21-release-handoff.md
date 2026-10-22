# October 21 Facebook specials release handoff

Status: October 21 regression resolved in production. Verification completed October 21, 2026, approximately 9:50 PM America/Chicago (CDT). No further production action is needed for this repair.

## Release identity and recovery

- Worker: `grayzn-fb-feed`; account `a79e3b4a2bb8dad70c75bceac4b1d3f9`.
- Active version, 100%: `0b1b32ff-f316-4974-9a2b-bd805e93b134`.
- Deployment: `23331704-f48e-41b0-a9b5-f74019e9daae`, October 21 at 5:02:44 PM CDT (`2026-10-21T22:02:44.73803Z`).
- Previous version for rollback: `14b6503d-0368-41db-89e1-39e8e477f496`.
- Pre-release D1 recovery bookmark is retained locally in `.wrangler/oct21-release-recovery-point.json`.
- Command used: `npx wrangler deploy --config workers/fb-feed/wrangler.toml --keep-vars`.
- Resume inspection confirmed the successful deployment and downloaded active source containing the normalization, recovery guard, and attention signal. No duplicate deployment was performed.
- Routes, queue, half-hour cron, settings and bindings were preserved. No Pages deployment, migrations, manual D1 changes or historical backfill were performed.

The release contains the October 21 repair atop `main` / `origin/main` at `0c4662345b48b260e588dbabca1f0c06d9b373da`. Runtime changes are confined to `worker.js`, `reconcile.js`, and `guarded-auto.js` under `workers/fb-feed`. At production verification the work was uncommitted. The subsequent authorized Git finalization separates October 20 documentation/recovery coverage from the October 21 repair. Runtime source hashes still match the deployed release; only fixture sanitization and documentation were adjusted for version control. Mexican Night and other unrelated work were preserved.

## Observed production processing

Cloudflare's Worker observability dashboard confirmed the first eligible scheduled invocation at 5:30 PM CDT on the new version, with outcome `ok`. Its event timestamp is `2026-10-21T22:30:52.221Z`; wall time 4598 ms. The 6:00 PM repeat invocation also ran on the same version with outcome `ok` (event timestamp `2026-10-21T23:00:52.554Z`, wall time 5364 ms). Later scheduled events were visible, including 6:30, 7:00, 8:00, 8:30 and 9:30 PM.

The inspected dashboard interval, 5:02–9:47 PM CDT, reported 33 successes and zero errors. No partial-import attention warning was observed in the inspected results. This is bounded release verification, not a guarantee against future unrelated failures. The direct historical telemetry API returned an authentication error; execution history was verified through the authenticated Cloudflare dashboard instead, without changing permissions.

D1 audit events 394 and 395, one for each October 21 import, record at `2026-10-21 22:30:50` UTC:

> GUARDED_AUTO: 2026-10-21; reconciled 2 source(s); 5 slot(s)

The morning import `2040fb4d298e73fb6eaf403e757bebac` and evening import `f3c887313e71468c9a6392b79af9b76c` both contributed. The malformed repeated-Wednesday weekly-shaped morning evidence was recovered, and its old rejected-source veto no longer blocked the valid evening evidence.

The morning import still retains its original `failed` / `rejected` extraction record and duplicate-weekday validation reason; the evening record remains `staged` / `ok`. Both retain pending review status. These historical status fields were not rewritten. The later successful reconciliation audits and actual published values establish recovery; the old failure is not evidence of a continuing publication block.

## D1 and website verification

A keyed comparison of all 1,028 before/after special-slot records found exactly five changes, all Wednesday October 21, all automation-owned and unlocked:

| Slot | Published value |
| --- | --- |
| Lunch 1 | French Dip with Beer Fries & a Drink $9.75 |
| All day 1 | Pizza Burger with Side Salad, Soup or Coleslaw $10.25 |
| All day 2 | Grilled Ham and Cheese with Cup of Soup or Coleslaw $7.25 |
| Nightly 1 | Wing Night!; Bone-In Wings $.89 each; Boneless Wings $.99 each |
| Soup | Chicken Noodle or Chili |

All remaining 1,023 slot records were unchanged, including protected/manual content. The replaced Chicken Salad and unpriced Wing Night/Add Fries content were recurring defaults, not staff-protected changes. No later duplicate reconciliation audit events or additional retries appeared in the post-release snapshot despite repeat scheduled execution, supporting idempotence for these posts.

The homepage and `/specials` both returned HTTP 200 and were fetched at approximately 9:46 PM CDT. Their October 21 cards match all five D1 values, including all three meal prices and both wing prices. The old Chicken Salad and Add Fries defaults are absent from the Wednesday cards. The Specials page displays Lunch 11 AM–1:30 PM and Nightly 5–10 PM. The homepage intentionally omits service-time labels in its existing compact presentation. Other dates' recurring values were not mistaken for Wednesday regressions.

## Validation and local evidence

The final release gate passed all 18 October 21 regression tests, the Wrangler deployment dry run and `git diff --check`. Earlier full Worker/application checks, the compiled two-page rendering regression, build and Astro checks were completed; environment-dependent D1 checks that initially failed were rerun successfully. See the investigation document for the detailed test history and root cause.

Approved local diagnostics are retained under `.wrangler/`:

- `oct21-release-before.json`, `oct21-release-after.json`: read-only D1 snapshots; remote queries wrote zero rows.
- `oct21-release-recovery-point.json`, `oct21-release-source-hashes.json`.
- `oct21-release-before-config.json`, `oct21-release-after-config.json`, `oct21-release-active-source.txt`.
- `oct21-release-tests.log`, `oct21-release-dry-run.log`, `oct21-release-deploy.log`.
- `oct21-release-page-home.html`, `oct21-release-page-specials.html`.

Diagnostic exports and filtered execution-log inspection were explicitly approved by the user after an initial automatic approval-review rejection. No credential values were included in the handoff.

## Next action

Stop this repair: the October 21 extraction, reconciliation, default replacement and publication regression is resolved in observed production behavior. No further deployment or data repair is required. Lunch capacity redesign and alert routing remain separate tasks; this release does not claim to eliminate every possible cause of recurring import failures.
