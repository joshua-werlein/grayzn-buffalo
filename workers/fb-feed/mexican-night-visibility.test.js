import test from 'node:test';
import assert from 'node:assert/strict';
import {mexicanNightDetailVisible} from '../../src/lib/mexican-night-visibility.js';

// All timestamps use CDT (America/Chicago UTC-5, applies in late September).
// Week under test: Sun 2026-09-27 through Sat 2026-10-03.
const SUN_NIGHT   = '2026-09-28T03:00:00Z'; // Sun 2026-09-27 22:00 CDT (when menu is created)
const MON_NOON    = '2026-09-28T19:00:00Z'; // Mon 2026-09-28 14:00 CDT
const TUE_EVENING = '2026-09-30T00:00:00Z'; // Tue 2026-09-29 19:00 CDT
const WED_159AM   = '2026-09-30T06:59:00Z'; // Wed 2026-09-30 01:59 CDT
const WED_200AM   = '2026-09-30T07:00:00Z'; // Wed 2026-09-30 02:00 CDT
const PREV_SUN    = '2026-09-21T03:00:00Z'; // Sun 2026-09-20 22:00 CDT (previous week)
const NEXT_MON    = '2026-10-05T19:00:00Z'; // Mon 2026-10-05 14:00 CDT (next week)

// updatedAt represents when this week's menu was published (Sunday night).
const THIS_WEEK_UPDATED = SUN_NIGHT;

test('Sunday night creation: visible immediately', () => {
  assert.equal(mexicanNightDetailVisible(THIS_WEEK_UPDATED, new Date(SUN_NIGHT)), true);
});

test('Monday: visible', () => {
  assert.equal(mexicanNightDetailVisible(THIS_WEEK_UPDATED, new Date(MON_NOON)), true);
});

test('Tuesday evening: visible', () => {
  assert.equal(mexicanNightDetailVisible(THIS_WEEK_UPDATED, new Date(TUE_EVENING)), true);
});

test('Wednesday 1:59 AM: still visible', () => {
  assert.equal(mexicanNightDetailVisible(THIS_WEEK_UPDATED, new Date(WED_159AM)), true);
});

test('Wednesday 2:00 AM: hidden', () => {
  assert.equal(mexicanNightDetailVisible(THIS_WEEK_UPDATED, new Date(WED_200AM)), false);
});

test('stale prior-week data: hidden even on Monday of the following week', () => {
  assert.equal(mexicanNightDetailVisible(PREV_SUN, new Date(MON_NOON)), false);
});

test('null updatedAt: always hidden', () => {
  assert.equal(mexicanNightDetailVisible(null, new Date(MON_NOON)), false);
});

test('undefined updatedAt: always hidden', () => {
  assert.equal(mexicanNightDetailVisible(undefined, new Date(MON_NOON)), false);
});

test('empty string updatedAt: always hidden', () => {
  assert.equal(mexicanNightDetailVisible('', new Date(MON_NOON)), false);
});

test('next-week viewing of this-week upload: hidden', () => {
  assert.equal(mexicanNightDetailVisible(THIS_WEEK_UPDATED, new Date(NEXT_MON)), false);
});
