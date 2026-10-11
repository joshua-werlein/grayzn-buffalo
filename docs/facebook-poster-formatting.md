# Facebook poster formatting improvement — October 11, 2026

## Confirmed cause and scope

The saved production snapshot after the successful 12:30 PM Chicago cron shows import `7276d795cf8df30e7627cf85ebb27fe6` with content and verbatim evidence both equal to `16'' 3-TOPPING PIZZA 12 WINGS $30`. The published Sunday Special was `16'' 3-Topping Pizza 12 Wings $30`. Extraction had already lost the inch mark and bundle relationship; deterministic canonicalization title-cased that flattened text but had no measurement normalization. The existing extraction instructions covered grouped choices, but did not explicitly instruct preservation of shared-price bundles, inch notation, or choice line breaks.

The repository was inspected before editing. It was on `main` at `fc1c3bb`, with ten uncommitted October 11 files. Those changes were preserved. A local ignored baseline snapshot records their original contents. This formatting task changes only `workers/fb-feed/reconcile.js`, `workers/fb-feed/extraction.js`, the pizza expectation in the existing `workers/fb-feed/oct11-regression.test.js`, and three new files: `workers/fb-feed/poster-formatting.test.js`, `tests/fixtures/poster-bundle-layout.json`, and this document. The exact historical extraction fixture remains unchanged.

## Implemented behavior

- `extraction.js`: shared formatting instructions reach initial extraction and targeted weekly-lunch/Mexican Night retries. They require ordinary double quotes for clear inch measurements, verbatim evidence, retention of printed `&`, `and`, and `+`, and preservation of OR alternatives. A clearly enclosed or explicitly established single-price bundle stays one offer, with `&` allowed between complete items when the image establishes the relationship. Adjacency and a nearby price alone are insufficient. Separate specials with independent prices remain separate offers. Explicitly grouped size/meal choices retain complete choice-price lines. Mexican Night keeps its single-line title contract and description line breaks. Unreadable required relationships produce an empty shape instead of a guessed relationship. Existing schema limits remain unchanged.
- `reconcile.js`: a numeric double-apostrophe, paired right-apostrophe, or double-prime measurement token normalizes to `"`. Attached words, opening quoted text, ordinary apostrophes and feet/inch compounds are excluded. The same normalization is used when checking labelled size/price associations, so two-apostrophe size notation cannot evade the existing ambiguity checks. Raw extraction and candidate text remain intact. Canonicalization never inserts a bundle connector from flattened text or combines offers.
- `oct11-regression.test.js`: only the expected inch mark changes. All 47 weekday/date/routing/ownership regressions remain in place; the historical fixture still lacks a connector.
- `tests/fixtures/poster-bundle-layout.json`: the user-confirmed original two-item/shared-price layout, an unrelated combo box, and consecutive independently priced offers. This is a human-described layout contract, not an actual image or model output.
- `poster-formatting.test.js`: seven-day layout contracts, formatting/idempotence examples, exact historical and correctly grouped October 11-style evidence, independently priced offers, size-price guards, limits, all three extraction request paths, guarded ownership, unchanged stored evidence, and weekly-lunch publication.

No parser/model/schema/configuration change is needed. Parser 18 is retained to avoid creating new identities for existing source versions. No dependencies, migration, Worker entry point, guarded-write logic, Pages source, or GitHub Actions file changes were made for formatting.

## Examples and intentional limits

| Source content | Publication after formatting |
| --- | --- |
| `16'' 3-TOPPING PIZZA 12 WINGS $30` | `16" 3-Topping Pizza 12 Wings $30` — no unsupported connector |
| `16" 3-TOPPING PIZZA & 12 WINGS $30` | `16" 3-Topping Pizza & 12 Wings $30` |
| `8'' Sub with Fries $11.75` | `8" Sub with Fries $11.75` |
| `2 Wraps + 1 Order of Fries $19` | Same text, quantities and shared price |
| `8'' Sub $10 / 12'' Sub $14` | `8" Sub $10` then `12" Sub $14`, on separate lines |
| `Wrap $11` then `OR Salad $12` | Same two lines and OR relationship |
| `Wrap Salad $12` | Same flattened text; no inferred bundle |
| `8'' or 12'' Pizza $14` | Remains blocked by existing ambiguous choice-price validation |
| `Chef's "Favorite" Sandwich $10` | Apostrophe and quotation marks unchanged |

The old October 11 evidence has no separator or visual layout evidence from which to recover one deterministically. Future image extraction is instructed to preserve the clearly established bundle. Tests mock model responses and inspect request instructions; they do not establish that every future model response will follow the instructions. No Workers AI call was made for this task. Unknown relationships, missing prices, and malformed prices are not repaired with menu knowledge. Ordinary description line wraps continue to collapse to spaces; complete independently priced choices retain their meaningful line breaks. Existing Wing Night and Mexican Night contracts remain authoritative.

## Production recommendation

Leave today's production text as published, as requested. Do not reset ownership, replay the post, edit import history, or update D1 to obtain a cosmetic change. After approval, verify a future normal post and cron. Staff locks and edits remain protected by the existing guarded writer.

One lifecycle detail matters: the current reconciler recalculates eligible same-day stored evidence on normal crons. A deployment before today's processing cutoff could therefore normalize the inch mark on an unchanged automation-owned slot even without replaying extraction. To leave today's values untouched, deploy after today's 8 PM Chicago cutoff or on a later day. The no-prior-day policy then excludes the October 11 daily post. A code change cannot safely recover its missing `&` from the stored evidence.

## Approved commit sequence and deferred Worker deployment

Recommend one reviewed commit containing both the already-deployed weekday fix and this formatting improvement. The current history does not yet contain the weekday fix, and `reconcile.js` and the new October 11 regression file now contain both concerns. A combined commit records the complete tested state without reconstructing or reverting any work. Separate commits are possible through careful staging against the preserved baseline: first the exact already-deployed weekday patch, then the formatting delta (including the updated test expectation). Do not deploy a partially staged version.

The owner's follow-up explicitly authorizes committing these reviewed changes, pushing to main and verifying the normal Pages workflow. Worker deployment is authorized only after 8 PM America/Chicago on October 11, and must not be scheduled unattended. Review the final diff and fourteen paths below before committing. The procedure is:

```powershell
git status --short
git diff --check
git diff -- workers/fb-feed/reconcile.js workers/fb-feed/extraction.js workers/fb-feed/guarded-auto.js workers/fb-feed/current-day.test.js workers/fb-feed/guarded-auto.test.js workers/fb-feed/weekly-lunch-regression.test.js tests/specials-auto-d1.test.mjs docs/facebook-specials-auto.md
# Also review the six new files listed in the staging command.
git add -- workers/fb-feed/reconcile.js workers/fb-feed/extraction.js workers/fb-feed/guarded-auto.js workers/fb-feed/current-day.test.js workers/fb-feed/guarded-auto.test.js workers/fb-feed/weekly-lunch-regression.test.js workers/fb-feed/oct11-regression.test.js workers/fb-feed/poster-formatting.test.js tests/specials-auto-d1.test.mjs tests/fixtures/oct11-sunday.json tests/fixtures/poster-bundle-layout.json docs/facebook-specials-auto.md docs/facebook-poster-formatting.md recovery/oct11-2026-specials.md
git diff --cached --stat
git diff --cached
git commit -m "Fix Facebook weekday evidence and preserve poster formatting"
# Only after approval of the exact included files:
git push origin main
# Separately, after explicit Worker deployment approval and at the chosen time:
npx wrangler deploy --config workers/fb-feed/wrangler.toml --keep-vars
```

The unchanged GitHub Actions workflow deploys Astro Pages on every push to `main`. A push therefore triggers that existing deployment even though no Pages code changed. No extra manual Pages deploy is needed, and pushing is not needed to execute the separately approved Worker command. Leave workflow path filters unchanged. After Worker deployment, confirm the active version and unchanged bindings/variables/schedule, then observe a normal future cron and inspect D1/public content with read-only checks. Do not force an import or replay historical data.

## Validation

Complete Worker suite: **830/830 passed**, zero failures/skips, including **46 new formatting tests** and all **47 existing October 11 weekday regressions**. Existing Friday, Monday, Wing Night, Mexican Night, weekly-lunch, price, default, date/retry and guarded-D1 tests all passed. The earlier focused suite passed 150/150 before the seven additional day-independent layout cases. Full local application suite: **126/126 passed**, zero failures/skips. Local Astro build and Worker dry run passed. `git diff --check` passed.

Local test commands were `node --test --test-concurrency=4 workers/fb-feed/*.test.js` and `node --test --test-concurrency=4 tests/*.test.mjs`; build was `npm run build`; Worker bundle verification used `npx wrangler deploy --dry-run --config workers/fb-feed/wrangler.toml`. Local runtime access was used for the D1 tests. Logs are in ignored `.wrangler/formatting-final-worker-tests.log`, `.wrangler/formatting-final-app-tests.log`, `.wrangler/formatting-targeted-tests.log`, `.wrangler/formatting-final-build.log`, and `.wrangler/formatting-final-dry-run-output.log`.

Pre-commit Git state: branch `main`, HEAD `fc1c3bb`, **8 modified tracked files and 6 untracked files**, fourteen paths total. The final approved commit contains only these paths. The baseline comparison confirmed all previous files other than `reconcile.js` and the one inch expectation in `oct11-regression.test.js` are byte-for-byte unchanged; subtracting the new formatting additions from those two files reproduces the preserved weekday-fix baseline exactly. No Workers AI call, production data mutation, migration, replay, ownership reset or Worker deployment is part of this release before the cutoff. Read-only checks can verify existing published content and historical import records.

Read-only production verification before the approved Git release confirmed all 16 October 11 Sunday slots unchanged from the successful noon-cron snapshot, all 35 import records identical, and no additional extraction/retry events. Every D1 query reported zero rows written. The earlier weekday-fix Worker version `7538dae5-7638-4a50-bac1-6fe9726b5f17` remains active at 100%; model, variables, webhook and half-hour cron remain unchanged. The formatting Worker has not been deployed, because this session is before the October 11 8 PM Chicago cutoff. No unattended deployment was scheduled.
