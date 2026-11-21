// Isolated local D1-runtime restore rehearsal (workerd D1 via Miniflare).
// Restores a private `wrangler d1 export` into an EMPTY local directory under a
// throwaway database name, then checks it. Prints aggregate counts and booleans
// only, never rows. Never touches remote resources or the production binding.
// Keep the export and the persist directory private (outside Git and temp).
// Usage (from repo root): node scripts/d1-restore-rehearsal.mjs <export.sql> <emptyPersistDir>
import { Miniflare } from 'miniflare';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [backup, persist] = process.argv.slice(2);
if (!backup || !persist) throw Error('usage: backup persistDir');
if (existsSync(persist) && readdirSync(persist).length) throw Error('persist dir must be empty (fresh restore only)');
const raw = readFileSync(backup);
const sql = raw.toString('utf8');
const out = { backupBytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') };

// Split the Wrangler export into statements: a statement ends at ';' at end of
// line with balanced single quotes ('' escapes keep parity).
const statements = []; let buf = '';
for (const line of sql.split('\n')) {
  buf += (buf ? '\n' : '') + line;
  if (/;\s*$/.test(line) && ((buf.match(/'/g) ?? []).length % 2 === 0)) { statements.push(buf.trim()); buf = ''; }
}
if (buf.trim()) throw Error('unterminated statement at end of export');
out.statements = statements.length;
const expected = {};
for (const s of statements) {
  const m = /^INSERT INTO "?([A-Za-z_0-9]+)"?/.exec(s);
  if (m) expected[m[1]] = (expected[m[1]] ?? 0) + 1;
}

const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }',
  d1Databases: { DB: 'restore-rehearsal-1121' }, d1Persist: persist });
try {
  const db = await mf.getD1Database('DB');
  // One transaction, as the export intends (PRAGMA defer_foreign_keys first).
  const started = Date.now();
  await db.batch(statements.map(s => db.prepare(s)));
  out.restoreMs = Date.now() - started;
  const one = async q => (await db.prepare(q).all()).results;
  out.quickCheck = (await one('PRAGMA quick_check'))[0];
  out.foreignKeyViolations = (await one('PRAGMA foreign_key_check')).length;
  const tables = (await one("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")).map(r => r.name);
  out.tables = tables.length;
  const mismatched = [];
  for (const t of tables) {
    const n = (await one(`SELECT count(*) n FROM "${t}"`))[0].n;
    if (n !== (expected[t] ?? 0)) mismatched.push({ t, restored: n, inExport: expected[t] ?? 0 });
  }
  out.rowCountMismatches = mismatched;
  out.migrations = (await one('SELECT count(*) n, max(name) last FROM d1_migrations'))[0];
  out.indexes = (await one("SELECT count(*) n FROM sqlite_master WHERE type='index'"))[0].n;
  out.lengths = (await one(`SELECT (SELECT max(length(name)) FROM items) item_name, (SELECT max(length(description)) FROM items) item_desc,
    (SELECT max(length(value)) FROM settings WHERE key LIKE 'announcement_%') announcement`))[0];

  // Application readers against the restored production schema (results summarized).
  const { loadTs } = await import(pathToFileURL(resolve('tests/load-ts.mjs')).href);   // repository root
  const env = { DB: db };
  const menu = await loadTs('src/lib/db.ts').getMenu(env);
  out.app = { categories: menu.categories.length, activeItems: menu.items.length };
  const ev = loadTs('src/lib/special-events.ts');
  const now = new Date();
  out.app.adminEvents = (await ev.readAdminEvents(env, now)).length;
  out.app.visibleEvents = (await ev.readVisibleEvents(env, now)).length;
  const anyEvent = (await one('SELECT id FROM special_events LIMIT 1'))[0];
  if (anyEvent) { const e = await ev.readEvent(env, anyEvent.id); out.app.readEvent = { ok: !!e, hasDisplayFrom: !!e && 'display_from' in e, hasEvidence: !!e && 'evidence_json' in e }; }
} finally { await mf.dispose(); }
console.log(JSON.stringify(out, null, 1));
