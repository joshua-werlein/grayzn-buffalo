#!/usr/bin/env node
// Fail-closed production apply for a reviewed scripts/menu-case-backfill.mjs plan.
//
// Preflight and write run in this one process, so no outer orchestration can skip
// the check: the write command is spawned only after every guard has been proven.
//
//   node scripts/d1-guarded-apply.mjs --plan <dir> --confirm <sha256 of apply.sql> [--preflight-only]
//
// Any of the following stops before the write and exits non-zero: apply.sql differs
// from changes.json or from the approved hash; a guard cannot be derived; Wrangler
// fails to start, exits non-zero or prints anything but the expected JSON; a result
// is missing, duplicated, unexpected, unsuccessful, does not match exactly one row,
// or reports writes. A zero exit code alone is never treated as success.
//
// Guards are evaluated with `d1 execute --command`, which returns one result row per
// guard. `--file` is not used for the preflight: remotely it goes through D1 import,
// which prints a progress preamble and returns only an aggregate summary
// (the November 7 failure).
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const DATABASE = 'grayzn-db';
export const CONFIG = 'workers/fb-feed/wrangler.toml';
const TABLES = new Set(['items', 'categories', 'special_collections', 'special_groups', 'special_slots']);
const MAX_QUERY_CHARS = 6000; // Well under the Windows command-line limit.

export class PreflightError extends Error {}

const quote = value => `'${String(value).replace(/'/g, "''")}'`;
export const sha256 = text => createHash('sha256').update(text).digest('hex');

/** apply.sql must be exactly comment lines followed by the manifest's statements, in order, as the generator writes it. */
export function checkPlan(applySql, changes) {
  if (!Array.isArray(changes) || !changes.length) throw new PreflightError('Manifest has no changes.');
  const body = changes.map(c => c.apply).join('\n') + '\n';
  const header = applySql.endsWith(body) ? applySql.slice(0, -body.length) : null;
  if (header === null || !/^(--[^\n]*\n)*$/.test(header)) throw new PreflightError('apply.sql does not match changes.json.');
}

/** The WHERE clause of one planned UPDATE, located by its exact generated prefix (never by searching quoted text). */
export function guardOf(change) {
  const {table, column, after, apply} = change ?? {};
  if (!TABLES.has(table) || typeof after !== 'string' || typeof apply !== 'string') throw new PreflightError('Unexpected change shape.');
  const set = column === 'content+last_auto_value' ? `content=${quote(after)},last_auto_value=${quote(after)}`
    : /^[a-z_]+$/.test(column ?? '') ? `${column}=${quote(after)}` : null;
  const prefix = `UPDATE ${table} SET ${set} WHERE `;
  if (!set || !apply.startsWith(prefix) || !apply.endsWith(';')) throw new PreflightError(`Cannot derive guard for ${change.label ?? table}.`);
  return apply.slice(prefix.length, -1);
}

/** Read-only queries returning one (statement_number, matches) row per planned statement. */
export function guardQueries(changes, maxChars = MAX_QUERY_CHARS) {
  const queries = [];
  let parts = [], numbers = [];
  changes.forEach((change, i) => {
    const part = `SELECT ${i + 1} AS statement_number,COUNT(*) AS matches FROM ${change.table} WHERE ${guardOf(change)}`;
    if (parts.length && [...parts, part].join(' UNION ALL ').length > maxChars) { queries.push({sql: parts.join(' UNION ALL '), numbers}); parts = []; numbers = []; }
    parts.push(part); numbers.push(i + 1);
  });
  if (parts.length) queries.push({sql: parts.join(' UNION ALL '), numbers});
  return queries;
}

/** Strict: the whole of stdout must be the JSON array Wrangler prints for --json. */
export function parseWranglerJson(stdout) {
  try { return JSON.parse(String(stdout ?? '').replace(/^﻿/, '').trim()); }
  catch { throw new PreflightError('Wrangler output is not the expected JSON.'); }
}

/** One query's parsed output proves every guard it covers matches exactly one row and nothing was written. */
export function verifyGuardResult(output, numbers) {
  if (!Array.isArray(output) || output.length !== 1) throw new PreflightError('Expected exactly one result set.');
  const [set] = output;
  if (set?.success !== true || !Array.isArray(set.results)) throw new PreflightError('Guard query did not succeed.');
  if (set.meta?.rows_written !== 0) throw new PreflightError('Guard query reported writes.');
  const seen = new Set();
  for (const row of set.results) {
    const keys = Object.keys(row ?? {}).sort().join();
    if (keys !== 'matches,statement_number') throw new PreflightError('Unexpected result columns.');
    if (!numbers.includes(row.statement_number) || seen.has(row.statement_number)) throw new PreflightError(`Unexpected result row ${row.statement_number}.`);
    if (row.matches !== 1) throw new PreflightError(`Guard ${row.statement_number} matched ${row.matches} rows.`);
    seen.add(row.statement_number);
  }
  const missing = numbers.filter(n => !seen.has(n));
  if (missing.length) throw new PreflightError(`Missing guard results: ${missing.join(',')}.`);
}

const checkRun = (result, what) => {
  if (!result || result.error || result.signal || result.status !== 0) throw new PreflightError(`${what} failed (exit ${result?.status ?? 'none'}).`);
  return result;
};

/**
 * Runs every guard, then (only if all pass and not preflightOnly) the write.
 * run(args) -> {status, stdout, stderr, error?, signal?} executes Wrangler with the given arguments.
 */
export function guardedApply({changes, applySql, applyFile, confirm, run, preflightOnly = false}) {
  const report = {statements: changes?.length ?? 0, guardsMatched: 0, applied: false};
  if (sha256(applySql) !== confirm) throw new PreflightError('apply.sql hash does not match the approved --confirm value.');
  checkPlan(applySql, changes);
  for (const {sql, numbers} of guardQueries(changes)) {
    let result;
    try { result = run(['d1', 'execute', DATABASE, '--config', CONFIG, '--remote', '--json', '--command', sql]); }
    catch (e) { throw new PreflightError(`Guard query could not run: ${e.message}`); }
    verifyGuardResult(parseWranglerJson(checkRun(result, 'Guard query').stdout), numbers);
    report.guardsMatched += numbers.length;
  }
  if (report.guardsMatched !== changes.length) throw new PreflightError('Not every guard was verified.');
  if (preflightOnly) return report;
  const result = run(['d1', 'execute', DATABASE, '--config', CONFIG, '--remote', '--json', '--file', applyFile]);
  report.applyStdout = result?.stdout ?? '';
  if (!result || result.error || result.signal || result.status !== 0) { report.applyFailed = true; return report; }
  report.applied = true;
  return report;
}

export function wranglerRunner(cwd = process.cwd()) {
  const bin = createRequire(join(cwd, 'package.json')).resolve('wrangler/bin/wrangler.js');
  return args => spawnSync(process.execPath, [bin, ...args], {cwd, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const value = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = value('--plan'), confirm = value('--confirm'), preflightOnly = argv.includes('--preflight-only');
  if (!dir || !/^[0-9a-f]{64}$/.test(confirm ?? '')) {
    console.error('Usage: node scripts/d1-guarded-apply.mjs --plan <dir> --confirm <sha256 of apply.sql> [--preflight-only]');
    process.exit(2);
  }
  const applyFile = join(dir, 'apply.sql');
  try {
    const report = guardedApply({changes: JSON.parse(readFileSync(join(dir, 'changes.json'), 'utf8')).changes,
      applySql: readFileSync(applyFile, 'utf8'), applyFile, confirm, run: wranglerRunner(), preflightOnly});
    if ('applyStdout' in report) writeFileSync(join(dir, 'apply-result.json'), report.applyStdout);
    const {applyStdout, ...summary} = report;
    console.log(JSON.stringify(summary, null, 2));
    process.exit(report.applyFailed ? 1 : 0);
  } catch (e) {
    console.error(`STOPPED before any production write: ${e.message}`);
    process.exit(1);
  }
}
