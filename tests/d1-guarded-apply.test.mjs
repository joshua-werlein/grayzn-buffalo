// Fail-closed production apply (scripts/d1-guarded-apply.mjs). Wrangler is mocked throughout;
// nothing here reaches D1. The write command must never run unless every guard is proven.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {plan} from '../scripts/menu-case-backfill.mjs';
import {guardedApply, guardQueries, guardOf, checkPlan, sha256, PreflightError} from '../scripts/d1-guarded-apply.mjs';

// A minimal schema with everything plan() reads, and one change of each guard shape.
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT,description TEXT);
    CREATE TABLE categories(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE weekly_specials(id INTEGER PRIMARY KEY,week_end_date TEXT);
    CREATE TABLE special_collections(id TEXT PRIMARY KEY,kind TEXT,weekly_special_id INTEGER,title TEXT,revision INTEGER DEFAULT 1);
    CREATE TABLE special_groups(id TEXT PRIMARY KEY,collection_id TEXT,label TEXT);
    CREATE TABLE special_slots(group_id TEXT,position INTEGER,content TEXT,origin TEXT,manual_locked INTEGER,manual_edited_at TEXT,price TEXT,section_link TEXT,last_auto_value TEXT);
    INSERT INTO items VALUES(1,'CHICKEN BACON RANCH WRAP','bacon, lettuce WHERE it''s fresh'),(2,'Taco Salad','');
    INSERT INTO categories VALUES(1,'ON THE LIGHTER SIDE');
    INSERT INTO special_collections VALUES('defaults','defaults',NULL,NULL,3),('mexican-night','section',NULL,'MEXICAN NIGHT',7);
    INSERT INTO special_groups VALUES('d:1','defaults','LUNCH SPECIALS'),('m:1','mexican-night','Tacos');
    INSERT INTO special_slots VALUES('d:1',1,'hot ham AND a drink','automation',0,NULL,'','','hot ham AND a drink'),
      ('m:1',1,'Enchilada
meat AND cheese','manual',0,NULL,'','',NULL);`);
  return db;
}
const header = '-- Menu/Specials capitalization backfill. Generated test.\n-- Each statement is guarded by the exact prior value. Re-running changes nothing.\n';
function fixturePlan() {
  const db = database(), {changes} = plan(db, '2030-01-01');
  const applySql = header + changes.map(c => c.apply).join('\n') + '\n';
  return {db, changes, applySql, applyFile: 'plan/apply.sql', confirm: sha256(applySql)};
}
const ok = stdout => ({status: 0, stdout, stderr: ''});
// Wrangler --command --json shape, evaluated against a real copy so passing guards are genuine.
const wranglerJson = (results, meta = {}) => JSON.stringify([{results, success: true, meta: {changes: 0, rows_read: 1, rows_written: 0, ...meta}}], null, 2);
function mockRunner(db, overrideGuard) {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args.includes('--file')) return ok(wranglerJson([{'Total queries executed': 1}], {rows_written: 1}));
    const sql = args[args.indexOf('--command') + 1];
    return overrideGuard ? overrideGuard(sql, db, calls) : ok(wranglerJson(db.prepare(sql).all().map(r => ({...r}))));
  };
  return {run, calls, writes: () => calls.filter(a => a.includes('--file'))};
}
function mustStop(t, overrideGuard, mutate = p => p) {
  const p = mutate(fixturePlan()), runner = mockRunner(p.db, overrideGuard);
  assert.throws(() => guardedApply({...p, run: runner.run}), PreflightError);
  assert.ok(runner.calls.length >= 1, 'the stop came from the preflight itself, not an earlier check');
  assert.equal(runner.writes().length, 0, 'the production-write command must never be invoked');
  return runner;
}

test('fixture plan covers every guard shape: item, lockstep slot and multiline staff slot', () => {
  const {changes} = fixturePlan();
  assert.deepEqual(changes.map(c => c.column).sort(), ['content', 'content+last_auto_value', 'description', 'label', 'name', 'name', 'title']);
  // A guard is located by its generated prefix, so " WHERE " inside a quoted value cannot truncate it.
  const description = changes.find(c => c.column === 'description');
  assert.match(guardOf(description), /^id=1 AND description='bacon, lettuce WHERE it''s fresh'$/);
});

test('REGRESSION Nov 7: the exact aggregate output of `--file` preflight stops before any write', t => {
  const nov7 = readFileSync(new URL('./fixtures/wrangler-remote-file-aggregate-20261107.txt', import.meta.url), 'utf8');
  assert.match(nov7, /Uploading complete/);
  // Wrangler exited 0 on November 7; that alone must not count as success.
  mustStop(t, () => ok(nov7));
  // Even with the preamble stripped, an aggregate summary is not per-guard evidence.
  mustStop(t, () => ok(nov7.slice(nov7.indexOf('['))));
});

test('preflight uses --command per-row queries, never --file, and is read-only by shape', () => {
  const p = fixturePlan(), runner = mockRunner(p.db);
  const report = guardedApply({...p, run: runner.run, preflightOnly: true});
  assert.equal(report.guardsMatched, p.changes.length);
  assert.equal(report.applied, false);
  assert.equal(runner.writes().length, 0, 'preflight-only never writes');
  for (const args of runner.calls) {
    assert.deepEqual(args.slice(0, 7), ['d1', 'execute', 'grayzn-db', '--config', 'workers/fb-feed/wrangler.toml', '--remote', '--json']);
    assert.equal(args[7], '--command');
    assert.match(args[8], /^SELECT 1 AS statement_number/);
    assert.doesNotMatch(args[8], /\b(UPDATE|INSERT|DELETE|DROP|ALTER)\b/);
  }
});

test('a successful preflight invokes the write exactly once, after all guards', () => {
  const p = fixturePlan(), runner = mockRunner(p.db);
  const report = guardedApply({...p, run: runner.run});
  assert.equal(report.applied, true);
  assert.equal(runner.writes().length, 1);
  assert.equal(runner.calls.at(-1), runner.writes()[0], 'the write is the last command');
  assert.deepEqual(runner.writes()[0], ['d1', 'execute', 'grayzn-db', '--config', 'workers/fb-feed/wrangler.toml', '--remote', '--json', '--file', 'plan/apply.sql']);
});

test('guards are chunked under the command-line limit and still cover every statement once', () => {
  const p = fixturePlan();
  const chunks = guardQueries(p.changes, 300);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flatMap(c => c.numbers), p.changes.map((_, i) => i + 1));
  const runner = mockRunner(p.db);
  assert.equal(guardedApply({...p, run: runner.run, preflightOnly: true}).guardsMatched, p.changes.length);
});

test('failed commands stop: non-zero exit, signal, spawn error or a throwing runner', t => {
  const good = (sql, db) => wranglerJson(db.prepare(sql).all().map(r => ({...r})));
  mustStop(t, (sql, db) => ({status: 1, stdout: good(sql, db), stderr: 'X [ERROR]'}));
  mustStop(t, (sql, db) => ({status: null, signal: 'SIGTERM', stdout: good(sql, db)}));
  mustStop(t, () => ({status: null, error: new Error('spawn ENOENT'), stdout: ''}));
  mustStop(t, () => { throw new Error('network down'); });
  mustStop(t, () => undefined);
});

test('a zero exit with missing or unparseable output stops', t => {
  for (const stdout of ['', '   ', 'null', 'Logged in\n[]', '[{"results":[', '{}', '[]', '[{"success":true}]'])
    mustStop(t, () => ok(stdout));
});

test('missing, failed, duplicated, unexpected or mismatched results stop', t => {
  const rows = (sql, db) => db.prepare(sql).all().map(r => ({...r}));
  mustStop(t, (sql, db) => ok(wranglerJson(rows(sql, db).slice(1))));                                       // missing guard
  mustStop(t, (sql, db) => ok(wranglerJson(rows(sql, db).map((r, i) => i ? r : {...r, matches: 0}))));      // value changed since export
  mustStop(t, (sql, db) => ok(wranglerJson(rows(sql, db).map((r, i) => i ? r : {...r, matches: 2}))));      // guard not unique
  mustStop(t, (sql, db) => ok(wranglerJson(rows(sql, db).map(r => ({...r, matches: '1'})))));               // wrong type
  mustStop(t, (sql, db) => ok(wranglerJson([...rows(sql, db), rows(sql, db)[0]])));                         // duplicate row
  mustStop(t, (sql, db) => ok(wranglerJson([...rows(sql, db), {statement_number: 999, matches: 1}])));      // unexpected row
  mustStop(t, (sql, db) => ok(wranglerJson(rows(sql, db).map(r => ({...r, extra: 1})))));                   // unexpected column
  mustStop(t, (sql, db) => ok(JSON.stringify([{results: rows(sql, db), success: false, meta: {rows_written: 0}}])));
  mustStop(t, (sql, db) => ok(JSON.stringify([{results: rows(sql, db), success: true}])));                  // no meta: invariant unproven
  mustStop(t, (sql, db) => ok(wranglerJson(rows(sql, db), {rows_written: 1})));                             // preflight wrote
  mustStop(t, (sql, db) => ok(JSON.stringify(JSON.parse(wranglerJson(rows(sql, db))).concat(JSON.parse(wranglerJson([])))))); // extra result set
});

test('a stale live row (edited after export) stops before writing', t => {
  const runner = mustStop(t, undefined, p => { p.db.exec("UPDATE items SET name='Edited by staff' WHERE id=1"); return p; });
  assert.ok(runner.calls.length >= 1);
});

test('apply.sql must equal the manifest and the approved hash, checked before Wrangler runs', t => {
  const none = () => assert.fail('no Wrangler call expected');
  const tampered = p => { const applySql = p.applySql.replace('Chicken Bacon Ranch Wrap', 'Chicken Bacon Ranch Wrap EXTRA'); return {...p, applySql, confirm: sha256(applySql)}; };
  for (const mutate of [p => ({...p, confirm: '0'.repeat(64)}), tampered,
    p => { const applySql = p.applySql + 'DELETE FROM items;\n'; return {...p, applySql, confirm: sha256(applySql)}; },
    p => ({...p, changes: p.changes.slice(1)}), p => ({...p, changes: []})]) {
    const p = mutate(fixturePlan());
    assert.throws(() => guardedApply({...p, run: none}), PreflightError);
  }
  assert.throws(() => checkPlan('', []), PreflightError);
  assert.throws(() => guardOf({table: 'special_imports', column: 'caption', after: 'x', apply: "UPDATE special_imports SET caption='x' WHERE id=1;"}), PreflightError);
});

test('a failed write is reported as a failure, never as applied', () => {
  const p = fixturePlan(), runner = mockRunner(p.db);
  const run = args => args.includes('--file') ? {status: 1, stdout: '', stderr: 'X [ERROR]'} : runner.run(args);
  const report = guardedApply({...p, run});
  assert.equal(report.applied, false);
  assert.equal(report.applyFailed, true);
});

test('CLI refuses without an approved hash and stops non-zero on a missing plan, without running Wrangler', () => {
  const cli = args => spawnSync(process.execPath, ['scripts/d1-guarded-apply.mjs', ...args], {encoding: 'utf8'});
  assert.equal(cli(['--plan', 'does-not-exist']).status, 2);
  const missing = cli(['--plan', 'does-not-exist', '--confirm', 'a'.repeat(64)]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /STOPPED before any production write/);
});
