# Fail-closed production apply (November 7 preflight failure)

## What happened

During the November 7 capitalization backfill, the read-only guard preflight was run as
`wrangler d1 execute --remote --file pre-apply-guard-check.sql --json`. Its validator
could not parse the output, yet the guarded `apply.sql` was executed next. The data
outcome was verified correct afterwards (see the audit report); the stop condition failed.

## Root cause

1. **Wrong command shape.** A remote `--file` execution goes through D1 import. Wrangler
   prints an upload progress preamble before the JSON and returns one aggregate summary
   (`Total queries executed: 117, Rows written: 0`), never per-statement result rows. The
   preflight could not produce the 117 `matches` rows the validator expected.
2. **A failed step did not gate the next one.** The orchestration ran the validator
   (`python -`) and the write as separate commands in one script. The validator raised
   `JSONDecodeError`, but the script did not check that command's exit code before
   issuing the next command. The `if ($LASTEXITCODE -ne 0)` in that command guarded
   only its own pause check, then ran the write.
3. **Exit code treated as evidence.** Wrangler exited 0 on the preflight, which says
   nothing about whether the expected results were present.

## Fix

`scripts/d1-guarded-apply.mjs` runs preflight and write in one process, so nothing
outside it can skip the check. The write is spawned only after all of these pass:

- `apply.sql` is exactly comment lines plus the manifest's statements, and its SHA-256
  equals the approved `--confirm` value.
- Each guard is the `WHERE` clause of a planned `UPDATE`, located by its exact
  generated prefix on an allowed table.
- Guards run as read-only `SELECT … COUNT(*) … UNION ALL` queries via `--command`,
  which returns one row per guard. Queries are chunked to stay under the Windows
  command-line limit.
- Each Wrangler call must start, exit 0 and print only JSON. Each result set must
  report `success: true` and `rows_written: 0`, with exactly columns
  `statement_number, matches`. Every statement number must appear exactly once with
  `matches === 1`, with no extra, duplicate, missing or mistyped rows.

Anything else throws, prints `STOPPED before any production write`, and exits 1. A
failed write is reported as a failure (exit 1), never as applied.

## Procedure for guarded production D1 data changes

This is mandatory for every guarded production D1 write. Never chain a Wrangler
preflight and a Wrangler write as separate commands, scripts or agent tool calls, and
never run `wrangler d1 execute --remote --file <apply.sql>` directly. The guard
accepts plans in the `scripts/menu-case-backfill.mjs` format: `changes.json`
(`changes[]` with `table`, `column`, `after`, `label`, `apply`, `rollback`) plus
`apply.sql`. If an operation cannot be expressed that way, stop and get a reviewed
extension of the guard first. Do not hand-run its SQL.

```sh
node scripts/d1-guarded-apply.mjs --plan <dir> --confirm <sha256> [--preflight-only]
```

| Argument | Required | Meaning |
|---|---|---|
| `--plan <dir>` | yes | Directory holding the generated `changes.json` and `apply.sql`. |
| `--confirm <sha256>` | yes | Lowercase hex SHA-256 of the exact approved `apply.sql`. |
| `--preflight-only` | no | Run every check and guard query, then exit without writing. |

The script always targets `grayzn-db` with `--config workers/fb-feed/wrangler.toml --remote`.
Exit codes: `0` checks passed (and the write succeeded, unless `--preflight-only`); `1`
stopped before writing, or the write itself failed; `2` usage error. The write's
output is saved to `<dir>/apply-result.json`.

Steps:

1. **Approval.** JJ approves the specific export, the generated `changes.json`,
   `apply.sql` and its SHA-256, and the maintenance window (automations paused, staff
   saves held, writes drained). Approval covers only that exact hash. Any regenerated
   plan needs new approval.
2. **Hash.** `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('<dir>/apply.sql')).digest('hex'))"`
   (or `Get-FileHash -Algorithm SHA256`, lowercased). It must equal the approved value.
3. **Preflight.** Run with `--preflight-only` and confirm the output shows
   `"guardsMatched"` equal to `"statements"`. This step is a production read and
   needs its own approval.
4. **Apply.** Run the same command without `--preflight-only`. It repeats the full
   preflight in the same process and only then writes.
5. **Verify.** Follow the post-apply verification of the procedure the plan came from
   (for capitalization, step 5 of [menu-capitalization.md](menu-capitalization.md)),
   then resume writes.

Mandatory stop conditions: the script stops by itself, before any write, on each of
these. Treat any stop as final for that run. Report it and do not retry with changes,
skip the script or run the write by hand without new approval.

- The plan directory, `changes.json` or `apply.sql` is missing or unreadable, or the manifest is empty.
- `apply.sql` is not exactly comment lines plus the manifest's statements, in order.
- The SHA-256 of `apply.sql` differs from `--confirm`.
- A statement is on a table outside the allowed set or its guard cannot be derived.
- Wrangler cannot start, is killed, or exits non-zero.
- Wrangler output is empty, has any non-JSON text (preamble, warnings) or is not one result set per query.
- A result set is not `success: true`, has no `meta`, or reports `rows_written` other than 0.
- A result row has unexpected columns, an unknown, duplicate or missing statement
  number, or `matches` other than the number 1 (for example, a value changed since export).

A zero exit code is never sufficient on its own. After a stop, writes stay paused until
JJ decides how to proceed.

## Tests (local only, Wrangler mocked)

`node --test tests/d1-guarded-apply.test.mjs`: 12 tests, all passing. Highlights:

- **Regression:** the exact November 7 output, saved as
  `tests/fixtures/wrangler-remote-file-aggregate-20261107.txt`, is fed in with exit 0,
  with and without its preamble. The guard stops, and the write is never invoked.
- Non-zero exit, signal, spawn error, a throwing runner and an empty result all stop.
- Unparseable, empty or wrongly shaped output stops.
- Missing, duplicated, unexpected, mismatched (0 or 2), mistyped or unsuccessful
  results stop. So does a result with no `meta` or any reported write.
- A live row edited after export stops.
- A tampered `apply.sql`, wrong hash or truncated manifest stops before Wrangler runs.
- A success runs only `--command` queries, then exactly one write as the last call.
  `--preflight-only` never writes.
- Every failure case asserts that the stop came from the preflight itself and that
  the write was not called.
- Mutation check: disabling the verifier makes 4 tests fail, including the regression.

Full application suite `node --test --test-concurrency=4 tests/*.test.mjs`: 357 pass, 0 fail.

A local replay of the real November 7 plan against its archived pre-apply export
(in-memory SQLite, no network) matched all 117 guards in 6 queries. The archived
November 7 output and the already-applied post-apply export both stop.

## Remaining limitations

- Not yet run against real D1. The `--command` JSON shape is taken from November 7
  production output of the same Wrangler version (`drain-first.json`). The first real
  use should be `--preflight-only`, which requires JJ's approval.
- Strict parsing means any extra stdout from Wrangler (a new warning, for example)
  stops the run. That is intentional: fix the invocation, never loosen the parser.
- The guard proves each row still holds its exported value right before the write;
  the writes-paused maintenance window still guards the gap between the two calls.
- The write's own output is saved to `apply-result.json` but not verified here.
  Post-apply verification (step 5 of `menu-capitalization.md`) is unchanged.
- Only forward `apply.sql` plans are guarded. `rollback.sql` is not yet supported
  (its statements are not in the apply form). A rollback remains a separately
  approved manual write until the guard is extended and reviewed.
- Plans must be in the backfill manifest format. Any other production write
  sequence needs the same rule (one process, verify before write) through a
  reviewed extension of this guard, never hand-chained commands.
