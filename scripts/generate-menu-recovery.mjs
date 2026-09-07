import { readFileSync, writeFileSync } from 'node:fs';

// The JSON is the shared fallback and recovery source; SQL is generated only.
const baseline = JSON.parse(readFileSync(new URL('../src/data/menu-baseline.json', import.meta.url), 'utf8'));
const quote = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : "'" + value.replaceAll("'", "''") + "'";
const insert = (table, rows) => {
  const fields = Object.keys(rows[0]);
  return `INSERT INTO ${table} (${fields.join(', ')}) VALUES\n` + rows.map(row => '(' + fields.map(key => quote(row[key])).join(', ') + ')').join(',\n') + ';\n';
};
// Fail before inserting anything if the target is not empty. No overwrite/delete.
const sql = `-- GENERATED from src/data/menu-baseline.json; see recovery/README.md.
-- Only for an EMPTY menu with the current schema. Not a live synchronization script.
CREATE TABLE _menu_recovery_guard (ok INTEGER CHECK (ok = 1));
INSERT INTO _menu_recovery_guard SELECT CASE WHEN
  (SELECT COUNT(*) FROM categories) = 0 AND (SELECT COUNT(*) FROM items) = 0
  THEN 1 ELSE 0 END;
` + insert('categories', baseline.categories) + insert('items', baseline.items) + 'DROP TABLE _menu_recovery_guard;\n';
writeFileSync(new URL('../recovery/menu-canonical.sql', import.meta.url), sql);
