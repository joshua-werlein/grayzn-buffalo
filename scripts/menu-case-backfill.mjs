#!/usr/bin/env node
// Reviewable, idempotent backfill of the house capitalization (src/lib/text-case.js)
// for EXISTING Menu and Specials text. New saves are normalized by the application.
//
// This script never connects to D1. It loads a D1 export into a private in-memory
// SQLite copy, plans guarded UPDATE statements, and rehearses them on that copy:
//
//   npx wrangler d1 export grayzn-db --remote --output backups/pre-menu-case.sql
//   node scripts/menu-case-backfill.mjs --export backups/pre-menu-case.sql --out backups/menu-case
//
// Outputs in --out: preview.md (counts, examples, rehearsal), apply.sql, rollback.sql.
// Every statement is guarded by the exact value it replaces, so a value changed after
// the export is skipped, and running apply.sql again changes nothing.
//
// In scope: items.name/description, categories.name, section titles, and group labels
// and slot content of the recurring defaults, the Mexican Night / Wing Wednesday
// sections and weeks ending on or after --today. Never changed: Facebook imports,
// evidence, audit/event logs, special events, past weeks, legacy tables, prices,
// schedules, service times and links.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {normalizeMenuCase} from '../src/lib/text-case.js';

export const load = file => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(file, 'utf8'));
  return db;
};
const quote = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`;

// Collections whose text is customer-facing now or later. Past weeks are history.
const SCOPE = `SELECT c.id FROM special_collections c LEFT JOIN weekly_specials w ON w.id=c.weekly_special_id
  WHERE c.kind IN ('defaults','section') OR (c.kind='week' AND w.week_end_date>=:today)`;

export function plan(db, today) {
  const changes = [], skipped = [];
  const field = (table, column, key, rows, guard = () => '') => {
    for (const row of rows) {
      const before = row[column];
      if (typeof before !== 'string') continue;
      const after = normalizeMenuCase(before);
      if (after === before) continue;
      const where = Object.entries(key(row)).map(([k, v]) => `${k}=${quote(v)}`).join(' AND ');
      changes.push({table, column, before, after, label: `${table}.${column} ${where}`,
        apply: `UPDATE ${table} SET ${column}=${quote(after)} WHERE ${where}${guard(row)} AND ${column}=${quote(before)};`,
        rollback: `UPDATE ${table} SET ${column}=${quote(before)} WHERE ${where}${guard(row)} AND ${column}=${quote(after)};`});
    }
  };
  field('items', 'name', r => ({id: r.id}), db.prepare('SELECT id,name FROM items ORDER BY id').all());
  field('items', 'description', r => ({id: r.id}), db.prepare('SELECT id,description FROM items ORDER BY id').all());
  field('categories', 'name', r => ({id: r.id}), db.prepare('SELECT id,name FROM categories ORDER BY id').all());
  field('special_collections', 'title', r => ({id: r.id}),
    db.prepare("SELECT id,title,revision FROM special_collections WHERE kind='section' ORDER BY id").all(), r => ` AND revision=${r.revision}`);
  const collectionGuard = r => ` AND EXISTS(SELECT 1 FROM special_collections c WHERE c.id=${quote(r.collection_id)} AND c.revision=${r.revision})`;
  field('special_groups', 'label', r => ({id: r.id}),
    db.prepare(`SELECT g.id,g.label,g.collection_id,c.revision FROM special_groups g JOIN special_collections c ON c.id=g.collection_id WHERE g.collection_id IN (${SCOPE}) ORDER BY g.id`).all({today}), collectionGuard);
  const slots = db.prepare(`SELECT s.*,g.collection_id,c.revision FROM special_slots s
    JOIN special_groups g ON g.id=s.group_id JOIN special_collections c ON c.id=g.collection_id
    WHERE g.collection_id IN (${SCOPE}) ORDER BY s.group_id,s.position`).all({today});
  for (const slot of slots) {
    const before = slot.content;
    if (typeof before !== 'string') continue;
    const after = normalizeMenuCase(before);
    if (after === before) continue;
    const identity = `group_id=${quote(slot.group_id)} AND position=${slot.position}`;
    const label = `special_slots.content ${identity}`;
    // A changed lock, ownership, edit time, price, link or parent revision also
    // fences out a stale plan, even if the displayed text stayed the same.
    const where = identity + collectionGuard(slot) + ['origin','manual_locked','manual_edited_at','price','section_link']
      .filter(column => column in slot).map(column => ` AND ${column} IS ${quote(slot[column])}`).join('');
    // The automation baseline moves with an untouched automation value, so every
    // "content = last_auto_value" ownership relation stays exactly as it was.
    const lockstep = slot.last_auto_value === before;
    if (!lockstep && slot.last_auto_value === after) {
      skipped.push({label, before, after, reason: 'Would make a staff-changed value look automation-owned; left for manual review.'});
      continue;
    }
    changes.push({table: 'special_slots', column: lockstep ? 'content+last_auto_value' : 'content', before, after, label,
      apply: lockstep
        ? `UPDATE special_slots SET content=${quote(after)},last_auto_value=${quote(after)} WHERE ${where} AND content=${quote(before)} AND last_auto_value=${quote(before)};`
        : `UPDATE special_slots SET content=${quote(after)} WHERE ${where} AND content=${quote(before)} AND last_auto_value IS ${quote(slot.last_auto_value)};`,
      rollback: lockstep
        ? `UPDATE special_slots SET content=${quote(before)},last_auto_value=${quote(before)} WHERE ${where} AND content=${quote(after)} AND last_auto_value=${quote(after)};`
        : `UPDATE special_slots SET content=${quote(before)} WHERE ${where} AND content=${quote(after)} AND last_auto_value IS ${quote(slot.last_auto_value)};`});
  }
  return {changes, skipped};
}

// Everything the backfill could touch or must preserve, for exact comparison.
const snapshot = db => JSON.stringify([
  db.prepare('SELECT * FROM items ORDER BY id').all(),
  db.prepare('SELECT * FROM categories ORDER BY id').all(),
  db.prepare('SELECT * FROM special_collections ORDER BY id').all(),
  db.prepare('SELECT * FROM special_groups ORDER BY id').all(),
  db.prepare('SELECT * FROM special_slots ORDER BY group_id,position').all(),
]);
// Every slot column except the text itself, plus whether it still equals its automation baseline.
const ownership = db => JSON.stringify(db.prepare('SELECT * FROM special_slots ORDER BY group_id,position').all()
  .map(({content, last_auto_value, ...fields}) => ({...fields, same: content === last_auto_value})));
const protectedTables = db => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('items','categories','special_collections','special_groups','special_slots') ORDER BY name").all()
  .map(({name}) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
const run = (db, sql) => {
  let changed = 0;
  for (const statement of sql) changed += Number(db.prepare(statement).run().changes);
  return changed;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) =>
    arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, []));
  const today = args.today ?? new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
  if (!args.export || !args.out || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    console.error('Usage: node scripts/menu-case-backfill.mjs --export <d1-export.sql> --out <dir> [--today YYYY-MM-DD]');
    process.exit(2);
  }
  const db = load(args.export);
  const {changes, skipped} = plan(db, today);
  const original = snapshot(db), originalOwnership = ownership(db), originalOther = protectedTables(db);
  const applied = run(db, changes.map(c => c.apply));
  const afterApply = snapshot(db);
  const rehearsal = {
    applied,
    replanned: plan(db, today).changes.length,
    reapplied: run(db, changes.map(c => c.apply)),
    ownershipUnchanged: ownership(db) === originalOwnership,
    otherTablesUnchanged: protectedTables(db) === originalOther,
  };
  rehearsal.stableAfterRepeat = snapshot(db) === afterApply;
  rehearsal.rolledBack = run(db, changes.map(c => c.rollback));
  rehearsal.restored = snapshot(db) === original;

  const counts = new Map();
  for (const c of changes) counts.set(`${c.table}.${c.column}`, (counts.get(`${c.table}.${c.column}`) ?? 0) + 1);
  const show = text => '`' + String(text).replace(/\r?\n/g, ' ⏎ ').replace(/`/g, "'") + '`';
  const examples = [...counts.keys()].flatMap(key => changes.filter(c => `${c.table}.${c.column}` === key).slice(0, 6)
    .map(c => `| ${key} | ${show(c.before)} | ${show(c.after)} |`));
  const ok = rehearsal.applied === changes.length && rehearsal.replanned === 0 && rehearsal.reapplied === 0
    && rehearsal.ownershipUnchanged && rehearsal.otherTablesUnchanged && rehearsal.stableAfterRepeat
    && rehearsal.rolledBack === changes.length && rehearsal.restored;
  const header = `-- Menu/Specials capitalization backfill. Generated ${new Date().toISOString()} from ${args.export}; today=${today}.\n`
    + '-- Each statement is guarded by the exact prior value. Re-running changes nothing.\n';
  mkdirSync(args.out, {recursive: true});
  if (!ok) throw new Error('Backfill rehearsal failed; no SQL generated.');
  writeFileSync(join(args.out, 'apply.sql'), header + changes.map(c => c.apply).join('\n') + '\n');
  writeFileSync(join(args.out, 'rollback.sql'), header.replace('backfill', 'backfill ROLLBACK') + changes.map(c => c.rollback).join('\n') + '\n');
  writeFileSync(join(args.out, 'changes.json'), JSON.stringify({today,changes,skipped},null,2) + '\n');
  writeFileSync(join(args.out, 'preview.md'), [
    `# Capitalization backfill preview`, '',
    `Source: \`${args.export}\` · weeks ending on or after ${today} · ${changes.length} change(s), ${skipped.length} skipped.`, '',
    '| Field | Rows changed |', '|---|---|', ...[...counts].map(([k, n]) => `| ${k} | ${n} |`), '',
    'Every affected row, exact before/after value and guarded operation is listed in `changes.json`.', '',
    '## Examples', '', '| Field | Before | After |', '|---|---|---|', ...examples, '',
    '## Skipped for manual review', '', ...(skipped.length ? skipped.map(s => `- ${s.label}: ${show(s.before)} → ${show(s.after)} (${s.reason})`) : ['None.']), '',
    '## Rehearsal on the in-memory copy', '', '```json', JSON.stringify(rehearsal, null, 2), '```', '',
    ok ? 'Rehearsal PASSED.' : 'Rehearsal FAILED. Do not apply.', '',
  ].join('\n'));
  console.log(JSON.stringify({changes: changes.length, skipped: skipped.length, byField: Object.fromEntries(counts), rehearsal, ok}, null, 2));
  process.exit(ok ? 0 : 1);
}
