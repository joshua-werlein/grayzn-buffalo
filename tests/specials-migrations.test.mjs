import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fixture} from './specials-fixture.mjs';
const source=JSON.parse(readFileSync('tests/fixtures/specials-production.json','utf8'));
test('production-shaped migration preserves all six weeks, 42 days and every legacy value',t=>{
  const f=fixture(t);
  assert.equal(source.weeks.length,6); assert.equal(source.days.length,42);
  assert.deepEqual(f.sql('SELECT * FROM weekly_specials ORDER BY id'),source.weeks);
  assert.deepEqual(f.sql('SELECT * FROM weekly_special_days ORDER BY id'),source.days);
  assert.deepEqual(f.sql('SELECT * FROM weekly_special_recurring_default_days ORDER BY day_of_week'),source.defaults);
  const slots=new Map(f.sql('SELECT * FROM special_slots').map(s=>[`${s.group_id}/${s.position}`,s]));
  const mapping=[['lunch_content','lunch',1],['nightly_content','nightly',1],['all_day_1_content','all-day',1],['all_day_2_content','all-day',2]];
  for(const [rows,prefix,key] of [[source.days,'day','id'],[source.defaults,'default','day_of_week']]) {
    for(const row of rows) for(const [field,service,position] of mapping) {
      const slot=slots.get(`${prefix}:${row[key]}:${service}/${position}`);
      assert.equal(slot.content,row[field]); assert.equal(slot.price,'');
      assert.equal(slot.origin,'legacy'); assert.equal(slot.manual_locked,1); assert.equal(slot.last_auto_value,null);
    }
  }
  assert.equal(f.sql("SELECT count(*) n FROM special_collections WHERE kind='week'")[0].n,6);
  assert.equal(f.sql("SELECT count(*) n FROM special_groups WHERE collection_id<>'defaults'")[0].n,126);
  assert.equal(f.sql('SELECT count(*) n FROM special_slots')[0].n,(42+7)*3*4);
  assert.deepEqual(f.sql('SELECT * FROM special_migration_checks'),[{version:15,mismatches:0}]);
  assert.ok(source.days.some(d=>d.nightly_content.includes('\n')));
  assert.ok(source.days.some(d=>d.lunch_content===''));
  assert.ok(source.defaults.some(d=>d.lunch_content===null));
});
test('legacy content tables are retained but cannot independently diverge',t=>{
  const f=fixture(t);
  for(const table of ['weekly_special_days','weekly_special_recurring_default_days']) {
    assert.throws(()=>f.sql(`UPDATE ${table} SET lunch_content='overwrite'`),/normalized editor/);
    assert.throws(()=>f.sql(`DELETE FROM ${table}`),/preserved/);
  }
});
test('Mexican Night contains only verified metadata and no invented menu groups',t=>{
  const f=fixture(t);
  assert.deepEqual(f.sql("SELECT title,schedule FROM special_collections WHERE id='mexican-night'"),[{title:'Mexican Night',schedule:'Tuesdays · 5 – 10 PM'}]);
  assert.deepEqual(f.sql("SELECT * FROM special_groups WHERE collection_id='mexican-night'"),[]);
});
test('new database bootstrap installs the same normalized schema and parity gate',()=>{
  const r=spawnSync('python',['-c',"import sqlite3,pathlib; c=sqlite3.connect(':memory:'); c.executescript(pathlib.Path('schema.sql').read_text(encoding='utf-8')); assert c.execute('SELECT mismatches FROM special_migration_checks').fetchone()[0]==0; assert c.execute('SELECT count(*) FROM special_slots').fetchone()[0]==84"],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
});
