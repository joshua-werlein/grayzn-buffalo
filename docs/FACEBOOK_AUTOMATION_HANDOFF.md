# Facebook automation reliability: handoff

Updated: 2026-10-12, after the final 2-call validation.
**Ready for a supervised, Worker-only production deployment, pending your approval.** All seven evaluated posters now produce the intended publication from ACTUAL Workers AI outputs, end to end through the guarded publisher, including the weekly-only and Mexican-only rereads (confirmed with the final two authorized calls). Conditions and caveats are in Deployment requirements and Remaining limitations.
Nothing has been committed, pushed, deployed or written to production D1/R2. No migration is needed. Evaluation report: [`docs/facebook-contract2-image-eval.md`](facebook-contract2-image-eval.md).

## Status at a glance

| Item | State |
|---|---|
| Worker suite `node --test workers/fb-feed/*.test.js` | **951 / 951 pass** |
| Application suite `node --test tests/*.test.mjs` | **126 / 126 pass** |
| `npx astro check` | 0 errors, 0 warnings (6 pre-existing hints) |
| `npm run build` | Complete |
| `wrangler deploy --dry-run` | **Not run**: blocked by the local permission layer. Run manually (see Deployment). |
| Real-image evaluation | 7 original posters; 22 Workers AI calls in total (20 evaluation + 2 final rereads), 0 errors. Round 2 used none. |
| Production deployment, D1/R2 writes, migrations, notifications | None |

Logs: `.wrangler/final-worker.log`, `final-app.log`, `final-astro.log`, `final-build.log` (ignored files).

## Should publish vs. Contract 2 now (saved real outputs, full pipeline)

| Poster | Result | Basis |
|---|---|---|
| Oct 10 Saturday | Intended: Saturday Special, two All Day, Soups list (1 call) | Real reading |
| Oct 11 Sunday | Intended: Sunday Special bundle, two All Day, Soups list (1 call) | Real reading |
| Oct 12 Monday | Intended: Lunch $9.75, Cheddar BLT $10.25; ambiguous Chicken Salad held, default kept (2 calls) | Real readings |
| Oct 12 weekly | Intended: five lunches for 10/12–10/16 after one weekly-only reread (2 calls) | Real first reading + **real reread** |
| Oct 6 Mexican Night | Intended: complete 12-item printed menu after one Mexican-only reread (2 calls) | Real first reading + **real reread** |
| Oct 5 Monday night | Intended: Nightly Burgers $14 + Ribs $18.75; All Day BLT + Chicken Salad (1 call) | Real readings |
| Oct 7 Wing Night | Intended: Wing Night $.89/$.99; two All Day; Soup (1 call) | Real reading |

Details, genuinely ambiguous facts and the round-1 defects are in the evaluation report.

## History

- Starting HEAD `61bfc6c` (Oct 11 fixes). Astra (Codex) implemented contract 2 locally, then exhausted usage while fixing protected-slot ordering and running final suites.
- Astra's last logs (17:52–17:54) reported Worker 866/866 and app 126/126, but `extraction.js`, `guarded-auto.js` and `worker.js` were edited at 17:55, **after** those runs. On takeover the current code failed **3 / 870** Worker tests.
- Claude Code completed the takeover; then a real-image evaluation (round 1) found a schema decoding trap and two validator false rejections, all fixed; round 2 restored the established business rules described below.

## Root causes being fixed (Oct 10–12)

Each day had a different trigger, one shared mechanism: exact-match rules turned a harmless variation in AI output into rejection of a whole poster, and recurring defaults stayed visible.

- Oct 10: `Soups:` plural defeated three-meal routing (fixture `tests/fixtures/oct10-saturday.json`).
- Oct 11: weekday only in heading (`oct11-sunday.json`).
- Oct 12: price inside the time field `11-1:30 (11-1:30) – $9.75`; All Day prices only in `evidence`; third meal genuinely printed without its "or" (`oct12-monday.json`, exact production extraction).

## Architecture (minimum change, no migration)

Reused: Workers AI binding and model, D1 `special_imports` JSON columns and `special_import_events`, R2 images, discovery scan, leases, durable call reservations, source-version identity, the guarded atomic batch publisher and all ownership predicates, weekly and Mexican Night adapters.

New: one pure module, `workers/fb-feed/evidence.js` (no I/O), the boundary between extraction facts and routing. Contract 2 extends the stored JSON only. Contract 1 remains selectable (`SPECIALS_EVIDENCE_VERSION` unset) for rollback; historical stored evidence still routes through the legacy reconciler. Contract-2 rows use parser version 19 (contract 1 keeps 18), so the contracts never supersede each other's evidence.

## Behavior (owner decisions applied 2026-10-12)

1. **Service: explicit evidence first.** An offer's own printed time/label decides. A `service_evidence` that only repeats the poster heading is heading scope, not offer evidence.
2. **Established house layouts as gated fallbacks**, filling only offers still lacking evidence; every printed label must agree; meals must be priced: day poster (Lunch/Day Special + two All Day; heading prints today and "Specials"); Wednesday Wing Night + two All Day; Monday/Friday four-offer night poster (no known All Day pair); night poster whose repeats exactly match a known All Day offer; single-service heading. No offer count is a universal requirement; labeled posters of any count route by evidence.
3. **Partial publication.** A meal with an unresolved service holds a verified offer only if it could take that slot (printed ahead of it while that service has free capacity) or is the same dish with different facts on any post. A meal with a content problem keeps its own slot (default stays); siblings publish. Bundles stay single offers; positions are stable; staff-locked and protected slots are never written.
4. **Same-cron repeats.** Verified All Day offers from this run's posts and existing automation identify identical repeats on other posts, in either processing order. Different price, sides or wording is never a repeat.
5. **Recovery.** One targeted single-shape reread for a weekly or Mexican Night poster read as daily offers (also a Tuesday reading with night offers or no offers), under every strategy. Factual issues may trigger one conditional repair; a missing service label never does. A reread that validates worse never replaces the first reading. Daily limit 50 and the per-source cap of 3 calls are unchanged.
6. **Other-day posts** are excluded, not blocking; self-contradictory day evidence still blocks.
7. **Silent fallback.** No notifications, warnings, review queue or automatic default edits. Recurring defaults stay visible whenever publication is unsafe.

## Files

| File | Change |
|---|---|
| `workers/fb-feed/evidence.js` (new) | Normalization, fact checks, service resolution, house layouts, scoped competition, same-cron repeats, slot assignment, weekly range parsing, evidence-bound size-label restoration |
| `workers/fb-feed/worker.js` | Contract-2 validation, shape guards and single-shape rereads, repair rules, per-source call cap, raw per-call audit, contract parser version |
| `workers/fb-feed/extraction.js` | Contract-2 schema (no model-facing version key), prompt, single-shape reread requests |
| `workers/fb-feed/guarded-auto.js` | Explicit positions, partial capacity check, other-day exclusion, contract-2 weekly week binding and peers, contract parser version |
| `workers/fb-feed/reconcile.js` | Contract-2 dispatch; exported `validateCurrentDay`, `hasWeeklyLunchEvidence` |
| `workers/fb-feed/classify.js` | `CONTRACT2_PARSER_VERSION = 19`, `parserVersionFor(env)` |
| `workers/fb-feed/wing-night.js` | `&` accepted between the two labelled prices |
| `workers/fb-feed/wrangler.toml` | `SPECIALS_EVIDENCE_VERSION="2"`, `SPECIALS_VERIFICATION_STRATEGY="conditional"` (contract 2 active on deploy; unset the version var to deploy contract 1 instead). |
| `tests/fixtures/oct12-monday.json`, `tests/fixtures/contract2-eval/` | Exact production extraction; actual model outputs incl. `*.final-reread.json`; `constructed/` is superseded and unused |
| Tests (new) | `reliability` 40, `reliability-takeover` 22, `house-convention` 29, `real-image-eval` 19 (end to end, real outputs), `same-cron` 8, `contract-rollback` 3 |

Every fix was mutation-checked: disabling it fails its tests; files were restored byte-identical afterward.

## Remaining limitations and risks

1. **Independence of the final fixes:** the weekly range and Taco Salad label fixes were derived from the same two outputs they were confirmed on. Both are narrow and fail safe, but they are not an independent accuracy measurement.
2. **Sample size:** 7 images, 9 distinct model readings. Friday night posters, multi-post days beyond the tested combinations, and caption-only posts are covered by mocked tests only. Every real reading so far transcribed facts faithfully; every failure was a shape, format or labelling issue, and after round 1 all failed safe.
3. **Mexican Night completeness:** per-item checks catch misread items, not omitted ones. The final reread was complete (legacy production's Oct 6 reading was not), but an omission would publish an incomplete menu.
4. **Cost:** a poster with one genuinely ambiguous item costs one extra call (factual repairs never resolved an issue in testing); weekly and Mexican Night cost 2 calls when first read as daily. Expected 2–6 calls/day against the 50-call limit. `single` strategy would save the factual repairs; shape rereads still run.
5. **Same-dish disagreement across posts holds All Day for the day** (by design); the recurring default stays visible.
6. Outdated production recurring defaults (for example Monday "…cup of Chili or Coleslaw") remain a staff data task.

## Deployment requirements (separate authorization needed)

1. ~~Final real-image confirmation of the weekly-only and Mexican-only rereads.~~ Done (2 calls, both pass after fixes).
2. Review the diff and commit (not done: `CLAUDE.md` reserves commits for the human).
3. Dry run manually: `npx wrangler deploy --dry-run --config workers/fb-feed/wrangler.toml --outdir .wrangler/dryrun`. Confirm bindings, routes, queue, cron `*/30 * * * *`, and the evidence/strategy vars.
4. Deploy the Worker only, with `--keep-vars`; no Pages deployment or migration.
5. **Rollback (now safe the same day):** unset `SPECIALS_EVIDENCE_VERSION` (contract 1, parser 18) or redeploy `e2429e44-9d38-42da-97dc-fc190a34c5cb`. Each contract reconciles only its own rows: a rollback re-stages today's posts under contract 1 (bounded AI use) and can publish them; switching back reuses contract-2 rows with no new calls.
6. **Supervised first week:** after each day's first posters, compare the published slots with the actual posters (read-only D1 and the site), and review import validation reasons, `evidence-v2-response` events and AI call counts. Roll back to contract 1 on any incorrect publication.
