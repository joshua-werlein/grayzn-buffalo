# October 28 delivery mismatch and publication review emails

Local implementation for review. No commit, push, deployment, production data
write, import replay, settings change, or real email was performed.

## Confirmed evidence

The checkout started clean on `main`, HEAD and freshly fetched `origin/main`
both at `5bf44e8e589934359ba0b619bdc6b4d2fea4d7ee`. The app's chat inventory
showed no other active chat editing this repository. No branches were changed.

Cloudflare's **project GET API**, rather than GitHub workflow status alone,
identified the canonical production Pages deployment:

- Project: `grayzn-buffalo`; custom domain: `grayznbuffalo.com`.
- Deployment: `d54ae2ff-c5dd-4965-a1b0-cf7100a0ea65`.
- Full commit: `5bf44e8e589934359ba0b619bdc6b4d2fea4d7ee`, clean `main`.
- Deployment stage: `deploy`, `success`, completed
  `2026-10-28T01:13:14.146073Z` (October 27, 8:13 PM Central).
- [Cloudflare deployment](https://dash.cloudflare.com/a79e3b4a2bb8dad70c75bceac4b1d3f9/pages/view/grayzn-buffalo/d54ae2ff-c5dd-4965-a1b0-cf7100a0ea65).

Wrangler's Worker deployment/version metadata independently confirmed 100%
deployment of `e0051002-f789-43a3-9510-4ffd3c368013`, annotated with commit
`79d6b49d15c8b1fe77d95fe7c26ec5e941598602`.

Narrow production SELECTs confirmed the following. All reported `changes=0`,
`changed_db=false`, and `rows_written=0`:

- Post `583672228384067_1748155386852338`, import
  `d780b3ab3c35ba35e3f1563ef1d953fa`, timestamp
  `2026-10-28T16:15:22+0000` (11:15:22 AM Central).
- Import staged, validation `ok`, review `pending`; delivery `available`,
  evidence `Delivery Available 11-1:30`, uncertainties `[]`, blocked flag null.
- Wednesday Lunch #1: `Garlic Turkey Bacon Sub with Sweet Potato Fries & a Drink - $9.75`,
  automation origin, unlocked.
- Wednesday All Day #1: `Grayz'n Burger with Side Salad or Coleslaw $10.25`,
  automation origin, unlocked.
- Wednesday All Day #2 retained:
  `Grilled Ham and Cheese with a Cup of Soup or Coleslaw $7.25`,
  manual origin, `manual_locked=1`.
- Facebook proposed:
  `Grilled Ham and Cheese with a Cup of Coleslaw $7.25`.
- Delivery setting `auto`; stored row `active=0`, expiration
  `2026-10-28T20:00:00.000Z`, observed at `20:00:49.028Z`.
- October 28 alert scan evaluation `complete`; incident count zero.

The fixture contains these public menu/incident fields. Its daily evidence
wrapper is reconstructed for tests and explicitly labeled as such; it is not
a raw production AI payload.

## Delivery root cause and local repair

At `79d6b49`, the shared delivery module calculated 3 PM Chicago. At `5bf44e8`,
it calculates 1:30 PM. Both versions required exact equality of the stored
expiration with their own deadline. On October 28 the old Worker wrote 20:00Z,
while the deployed Pages source expected 18:30Z. Consequently, **even an active,
same-day row would be hidden before 1:30 PM** by the deployed Pages predicate.
The regression reproduces that counterfactual with an active legacy row.

This proves the deployment incompatibility. The currently expired row does
**not** establish whether the Worker activated delivery earlier, or what an
individual visitor saw. No historical activation claim is made.

`src/lib/delivery.js` now recognizes only the current expiration and the known
legacy deadline exactly 90 minutes later. The independent Chicago weekday,
same-day, numeric active flag, and **1:30 PM cutoff** remain mandatory. Arbitrary,
malformed, earlier, or next-day deadlines remain hidden. DST is covered on both
sides of both annual clock changes. Manual Available, Unavailable, and Hidden
retain precedence at all times.

Both `Base.astro` and `specials.astro` already use this shared resolver, so no
duplicated template changes are needed. Their compiled production components
are tested with the legacy row. The Worker already imports the current shared
deadline; its next authorized deployment will write 1:30 PM. No extraction,
cancellation, ambiguity, date validation, expiration write, or snapshot fence
was relaxed. A compatibility gate is unnecessary for this specifically supported
version pair; future deadline/schema changes still require a compatibility
review. This does not make arbitrary future versions compatible.

## Why no email was generated

`dailyPublicationObservation()` explicitly suppressed all holds whose reason
was `Protected or ineligible destination slot` (and certain intentional blocked
indices). `recordVerified()` creates a new incident only for `attention`.
The protected October 28 slot therefore produced no durable incident, consistent
with the complete evaluation and zero incidents. This is a policy suppression,
not evidence of a failed Resend send or failed AI extraction.

Blocked publication proposals now enter the existing `publication_blocked`
incident. The verified diagnostic distinguishes a real staff lock/disabled
destination from another ineligible destination. Staff-only holds use an
informational subject and explain that staff action is optional. Mixed/validation
holds retain the review classification. Source import failures still retain
their established cause codes.

## Exact source changes

- `src/lib/delivery.js`: narrowly compatible expiration recognition while
  preserving the independent 1:30 PM rendering deadline.
- `workers/fb-feed/alert-policy.js`: reviewable protected holds become attention.
- `workers/fb-feed/alert-detail.js`: bounded verified post times and safe source
  links, current result, exact destination/position, proposed/retained values,
  published values, lock/disabled/ineligibility reasons, optional staff action,
  and delivery evidence/setting/reconciliation/current visibility/expiry mismatch.
- `workers/fb-feed/alert-runtime.js`: attaches diagnostics from the same fenced
  snapshot, and uses the same delivery resolver as Pages to avoid a false
  delivery outage for a recognized legacy deadline.
- `workers/fb-feed/alert-email.js`: informational staff-protection subject.
- Tests: `alert-detail.test.js`, `alert-runtime.test.js`, `alerts.test.js`,
  `delivery.test.js`, `oct21-regression.test.js`,
  `tests/specials-rendering.test.mjs`, and the October 28 fixture. The two older
  October 21 assertions were updated from suppressed to reviewable incidents;
  assertions preserving staff values, locks, and disabled groups remain.

`alert-store.js`, `alert-resend.js`, publication SQL, provider configuration,
secrets, schema, and deployment configuration are unchanged. The 30-minute grace,
daily scope/code deduplication, durable uncertain-send quarantine, no automatic
retry of uncertain sends, provider gating, and final SQL evidence fences remain.
Repeated unchanged half-hour scans produce one notification. Daily deduplication
also retains its existing limitation: a later distinct issue in the same daily
scope/code does not generate another email that day.

Email remains plain text. Reasons/classifications are application-owned; source
text is bounded and stripped of links, addresses, markup/control/bidi characters.
Post links are generated only from numeric Facebook IDs, and admin links from
validated identifiers. Arbitrary JSON, captions, raw model output, secrets, and
provider errors are not forwarded. Unavailable facts remain unknown.

## Before and after email example

**Before (actual October 28 behavior):** no email; protected hold suppressed;
zero incidents. There was no delivered generic email to quote.

**After (local fixture, not sent; this is not a historical delivery claim):**

```text
Subject: Grayz'n Buffalo publication review (staff protection) — 2026-10-28
Result: Partially Published (current verified snapshot)
Classification: informational staff protection; AI extraction did not fail.
Facebook posted: 2026-10-28, 11:15 AM (Chicago)
Source: https://www.facebook.com/583672228384067/posts/1748155386852338
Destination: Wednesday All Day #2
Reason: Staff-locked destination; existing website value retained
Staff lock: yes
Facebook proposed: Grilled Ham and Cheese with a Cup of Coleslaw $7.25
Website retained: Grilled Ham and Cheese with a Cup of Soup or Coleslaw $7.25
Published value: Wednesday Lunch #1: Garlic Turkey Bacon Sub with Sweet Potato Fries & a Drink $9.75
Published value: Wednesday All Day #1: Grayz'n Burger with Side Salad or Coleslaw $10.25
Delivery setting: auto; reconciliation: expected
Delivery visibility at 2026-10-28T16:46:00.000Z: available
Delivery evidence (available): Delivery Available 11-1:30
Staff action: optional. The staff-entered value or disabled destination was preserved.
```

The example abbreviates the body; the real formatter also includes the expected
and stored UTC expirations, first-detection time, admin editor, and exact import
review link. The local pipeline above writes the new 18:30Z deadline. A separate
legacy-active-row test reports expected 18:30Z versus stored 20:00Z and explains
that the recognized mismatch still renders only until 1:30 PM. An expired-row
test reports current hidden visibility and explicitly says earlier activation
is not established. Production Lunch currently has the additional ` - ` before
its price; the reconstructed local candidate above does not.

## Validation

| Check | Result |
| --- | --- |
| Focused alert detail, policy/store, and mocked Resend suite | 61/61 passed |
| October 28 focused cases (including legacy deadline and exact email details) | 6/6 passed |
| Runtime compatible versus unknown deadline regression | 1/1 passed |
| October 21 regression after updating obsolete suppression expectations | 22/22 passed |
| Compiled homepage/specials deadline and manual override regression | 1/1 passed |
| Complete application suite against completed build | 240/240 passed, zero skips |
| Complete Worker suite, final rerun | 1,371/1,371 passed, zero failures/cancellations/skips |
| `npx astro check` | 0 errors, 0 warnings, 16 existing hints |
| `npm run build` | Passed |
| `wrangler deploy --dry-run --config workers/fb-feed/wrangler.toml` | Passed; exited without deploying |
| `git diff --check` | Passed |

Commands for the complete suites: `node --test --test-concurrency=8
workers/fb-feed/*.test.js` and `node --test --test-concurrency=4 tests/*.test.mjs`.
Runtime was Node v24.19.0; no dependency or runtime changes were made.

Initial failures were identified rather than discounted: three Miniflare
localhost requests were blocked by the sandbox, and the mocked workerd Resend
test had the same localhost restriction; these were rerun with local-runtime
access. An application rendering test ran while a parallel build replaced
`dist`, causing ENOENT; the complete application rerun after the build passed.
The first complete Worker run had 1,368 passes and two obsolete assertions
expecting staff holds to be suppressed. The affected file passed 22/22 after
updating those assertions. The final complete Worker run includes that change
and the additional runtime regression. No production/provider calls were used
by these tests.

Local ignored logs: `.tmp-oct28-worker-final.log`, `.tmp-oct28-app-final.log`,
`.tmp-oct28-focused-final.log`, `.tmp-oct28-astro.log`, `.tmp-oct28-build.log`,
and `.tmp-oct28-dry-run.log`.

## Proposed release sequence — requires explicit authorization

1. Review the local diff and validation results; refresh production deployment
   metadata and staff state immediately before release. Do not replay October 28
   or send a historical/test email. Prefer the next normal service day.
2. Authorize commit/push separately: pushing `main` automatically deploys Pages.
   Release **Pages first**, containing the compatible resolver. Verify Cloudflare's
   canonical commit and successful deployment stage, and both public surfaces.
3. With separate Worker deployment authorization, deploy the reviewed Worker from
   the same commit, retaining existing secrets/settings/provider configuration.
   Verify its deployed version and recorded commit. No migration is needed.
4. Observe a naturally arriving eligible current-day poster. Read-only checks
   must confirm accepted evidence, unchanged staff lock/value, 1:30 PM stored
   expiration, visibility before cutoff, hidden automatic notices at/after
   cutoff, and correct notification/deduplication after grace if a new hold occurs.
   Real test email requires separate approval; provider acceptance alone does not
   prove inbox receipt.
5. If rollback is needed, keep the compatible Pages renderer in place. Rolling
   Pages back to the old exact-equality predicate while Worker versions disagree
   recreates the mismatch. Do not clear incident records, unlock staff values,
   rewrite production delivery rows, or replay imports as a rollback technique.

Remaining production questions: whether delivery was active before expiration on
October 28 requires earlier logs/snapshots; current D1 cannot answer it. Local
tests do not prove a released deployment or real inbox receipt. Production is
unchanged and must be verified after an authorized release.
