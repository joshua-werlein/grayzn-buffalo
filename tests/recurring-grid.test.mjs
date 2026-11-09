import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Lock the intended breakpoint rules; actual browser geometry is verified in
// the independent migration review at 375, 390, 768, 1024 and desktop widths.
test('six recurring cards use explicit 3/2/1 columns rather than auto-fit', () => {
  const source = readFileSync('src/pages/specials.astro', 'utf8');
  const base = source.match(/\.recurring-grid\s*\{([^}]+)\}/)[1];
  assert.match(base, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(base, /auto-fit|auto-fill/);
  assert.match(source, /@media\(max-width:1023px\)\{\s*\.recurring-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(source, /@media\(max-width:520px\)\{\s*\.recurring-grid\{grid-template-columns:minmax\(0,1fr\)\}/);
  // Catch later overrides accidentally restoring the old phone 2-column rule.
  assert.equal([...source.matchAll(/\.recurring-grid\s*\{/g)].length, 3);
  assert.match(source, /\.rec-placard\s*\{[^}]*min-width:0;overflow-wrap:anywhere;/);
});
