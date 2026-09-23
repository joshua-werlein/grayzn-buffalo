import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCaption, PARSER_VERSION } from './classify.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function isWeek(r, day, service) {
  assert.equal(r.kind, 'week');
  assert.equal(r.day, day);
  assert.equal(r.service, service);
  assert.equal(r.collectionId, null);
}

function isSection(r, collectionId) {
  assert.equal(r.kind, 'section');
  assert.equal(r.collectionId, collectionId);
  assert.equal(r.day, -1);
}

function isAmbiguous(r, day) {
  assert.equal(r.kind, 'ambiguous');
  assert.equal(r.day, day);
  assert.equal(r.service, null);
}

function isIgnored(r) {
  assert.equal(r.kind, 'ignored');
}

// ── PARSER_VERSION contract ───────────────────────────────────────────────────

test('PARSER_VERSION is a positive integer', () => {
  assert.ok(Number.isInteger(PARSER_VERSION) && PARSER_VERSION > 0);
});

// ── Spec examples (required by Milestone B) ───────────────────────────────────

test('Monday Lunch Specials → Monday / Lunch', () => {
  isWeek(classifyCaption('Monday Lunch Specials'), 1, 'lunch');
});

test('Monday Night Specials → Monday / Nightly', () => {
  isWeek(classifyCaption('Monday Night Specials'), 1, 'nightly');
});

test('Friday Night Specials → Friday / Nightly', () => {
  isWeek(classifyCaption('Friday Night Specials'), 5, 'nightly');
});

test('Weekly Lunch Specials → week, null day, lunch', () => {
  isWeek(classifyCaption('Weekly Lunch Specials'), null, 'lunch');
});

test('Mexican Night → section:mexican-night', () => {
  isSection(classifyCaption('Mexican Night'), 'mexican-night');
});

test('Tuesday Specials → ambiguous (no service)', () => {
  isAmbiguous(classifyCaption('Tuesday Specials'), 2);
});

// ── Empty / generic captions ──────────────────────────────────────────────────

test('empty string → ignored', () => {
  isIgnored(classifyCaption(''));
});

test('whitespace-only → ignored', () => {
  isIgnored(classifyCaption('   \t\n  '));
});

test('null → ignored', () => {
  isIgnored(classifyCaption(null));
});

test('undefined → ignored', () => {
  isIgnored(classifyCaption(undefined));
});

test('generic promotion caption → ignored', () => {
  isIgnored(classifyCaption('Come join us for a great time at Grayzn Buffalo!'));
});

test('post with only a price → ignored', () => {
  isIgnored(classifyCaption('$10.99 all night'));
});

// ── All days (spec completeness) ──────────────────────────────────────────────

test('Sunday Lunch Specials → day 0 / lunch', () => {
  isWeek(classifyCaption('Sunday Lunch Specials'), 0, 'lunch');
});

test('Wednesday Night Specials → day 3 / nightly', () => {
  isWeek(classifyCaption('Wednesday Night Specials'), 3, 'nightly');
});

test('Saturday Specials → ambiguous, day 6', () => {
  isAmbiguous(classifyCaption('Saturday Specials'), 6);
});

// ── Case insensitivity ────────────────────────────────────────────────────────

test('lowercase monday lunch specials → Monday / Lunch', () => {
  isWeek(classifyCaption('monday lunch specials'), 1, 'lunch');
});

test('FRIDAY NIGHT SPECIALS (all-caps) → Friday / Nightly', () => {
  isWeek(classifyCaption('FRIDAY NIGHT SPECIALS'), 5, 'nightly');
});

test('MeXiCaN NiGhT → section', () => {
  isSection(classifyCaption('MeXiCaN NiGhT'), 'mexican-night');
});

// ── "Nightly" spelling variant ────────────────────────────────────────────────

test('Tuesday Nightly Specials → Tuesday / nightly', () => {
  isWeek(classifyCaption('Tuesday Nightly Specials'), 2, 'nightly');
});

test('Weekly Nightly Specials → week null / nightly', () => {
  isWeek(classifyCaption('Weekly Nightly Specials'), null, 'nightly');
});

// ── Mexican Night isolation ───────────────────────────────────────────────────

test('Tuesday Night Specials does NOT produce section:mexican-night', () => {
  const r = classifyCaption('Tuesday Night Specials');
  assert.notEqual(r.kind, 'section');
  isWeek(r, 2, 'nightly');
});

test('long caption with Mexican Night phrase → section', () => {
  isSection(classifyCaption('Tonight is Mexican Night! Come check out our specials.'), 'mexican-night');
});

// ── Ambiguous detection ───────────────────────────────────────────────────────

test('Thursday Specials → ambiguous, day 4', () => {
  isAmbiguous(classifyCaption('Thursday Specials'), 4);
});

test('Monday Special (singular) → ambiguous', () => {
  isAmbiguous(classifyCaption('Monday Special'), 1);
});

// ── Ignored edge cases ────────────────────────────────────────────────────────

test('day mentioned without "specials" keyword → ignored', () => {
  isIgnored(classifyCaption('Stop in on Friday and see us!'));
});

test('just "Specials" with no day → ignored', () => {
  isIgnored(classifyCaption('Specials'));
});

test('non-string number → ignored', () => {
  isIgnored(classifyCaption(42));
});

// ── result shape ──────────────────────────────────────────────────────────────

test('every result has kind, day, service, collectionId, reason fields', () => {
  for (const caption of [
    'Monday Lunch Specials', 'Mexican Night', 'Tuesday Specials', '',
    'Friday Night Specials', 'Weekly Lunch Specials', 'Random post',
  ]) {
    const r = classifyCaption(caption);
    assert.ok('kind' in r);
    assert.ok('day' in r);
    assert.ok('service' in r);
    assert.ok('collectionId' in r);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  }
});

test('All Day and Nightly captions are explicit; mixed or weekly captions are never a unique day/service',()=>{
  isWeek(classifyCaption('Wednesday All Day Specials'),3,'all-day');
  isWeek(classifyCaption('Wednesday Nightly Specials'),3,'nightly');
  isWeek(classifyCaption('Wednesday Lunch Specials'),3,'lunch');
  isAmbiguous(classifyCaption('Wednesday Specials'),3);
  isAmbiguous(classifyCaption('Wednesday Lunch and Night Specials'),3);
  isAmbiguous(classifyCaption('Wednesday and Thursday Lunch Specials'),null);
  isWeek(classifyCaption('Weekly Wednesday All Day Specials'),null,'all-day');
  isIgnored(classifyCaption('Specials Today'));
});
