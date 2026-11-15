// Guards the homepage Facebook billboard and menu-card layout rules against the
// regressions measured on production in November 2026: posting-date labels clipped
// under the billboard edge, bare wall showing through the planks, posters too small
// in a four-across row, hover enter/leave loops, and menu copy overflowing its sheet.
// These are source-level checks; the visual behaviour itself was verified in a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync('src/pages/index.astro','utf8');
const rules=(selector)=>{
  const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return [...source.matchAll(new RegExp(`${escaped}\\{([^}]*)\\}`,'g'))].map(match=>match[1]);
};
const media=(query)=>{
  const start=source.indexOf(`@media ${query}{`);
  assert.notEqual(start,-1,`missing @media ${query}`);
  return source.slice(start,source.indexOf('\n',start));
};

test('poster offsets take part in layout so date labels cannot slide under the clipped billboard edge',()=>{
  const cardRules=rules('#social .fb-card');
  assert.ok(cardRules.length>=3);
  for(const body of cardRules) assert.doesNotMatch(body,/(^|;)top:/,'a relative top offset does not grow the billboard');
  assert.match(source,/@media \(min-width:1601px\)\{#social \.fb-billboard__middle\{padding-top:14px[^\n]*#social \.fb-card\{margin-top:calc\(clamp\(16px,1\.4vw,20px\) \+ var\(--fb-card-offset\)\)\}/);
  assert.match(media('(max-width:1600px)'),/#social \.fb-card\{margin-top:var\(--fb-card-offset\)\}/);
  // The middle section still clips its plank background, which is why the offset must be in flow.
  assert.match(rules('#social .fb-billboard__middle')[0],/overflow:hidden/);
});

test('the billboard is four across only from 1601px, in step with the script that moves the View Post links',()=>{
  assert.match(media('(max-width:1600px)'),/#social \.fb-grid,#social \.fb-grid\[data-count="3"\],#social \.fb-grid\[data-count="4"\]\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(media('(max-width:1600px)'),/#social \.fb-bottom-actions\{display:none\}/);
  assert.match(source,/const facebookDesktopQuery = window\.matchMedia\('\(min-width: 1601px\)'\);/);
  assert.doesNotMatch(source,/1400px|1399px/);
  assert.doesNotMatch(source,/matchMedia\('\(min-width: 1101px\)'\)/);
  assert.doesNotMatch(source,/@media \(max-width:1100px\)\{#social \.fb-/);
});

test('real posts set the billboard height; the reserved height is only for the fallback message',()=>{
  assert.match(source,/#social \.fb-billboard__middle:has\(\.fb-grid\[data-count\]\)\{min-height:0\}/);
});

test('plank slices always cover the real height and are not rebuilt on every resize',()=>{
  const start=source.indexOf('function syncBillboardMiddleSlices()');
  const body=source.slice(start,source.indexOf('\n  }\n',start));
  assert.match(body,/const sliceCount = Math\.max\(1, Math\.ceil\(\(height \+ 1\) \/ sliceHeight\)\);/);
  assert.doesNotMatch(body,/facebookDesktopQuery/,'no fixed desktop plank count');
  assert.doesNotMatch(body,/replaceChildren/,'existing planks stay in place during a resize');
  assert.doesNotMatch(body,/style\.height/,'plank height comes from CSS');
  assert.match(rules('#social .fb-billboard__middle-slice')[0],/width:100%;height:auto;aspect-ratio:16 \/ 3;object-fit:fill/);
});

test('hovered posters and menu cards keep the strip they lift away from, so hover cannot loop',()=>{
  assert.match(rules('#social .fb-card:hover::before')[0],/content:"";display:block;position:absolute;z-index:-1;inset:-4px -12px -10px/);
  assert.match(rules('#menu-preview .menu-card:hover::after')[0],/content:"";position:absolute;z-index:-1;inset:-2px -2px -9px/);
  // The lift itself is retained.
  assert.match(rules('#social .fb-card:hover')[0],/transform:translateY\(-3px\) rotate\(var\(--post-hover-tilt\)\)/);
  assert.match(source,/#menu-preview \.menu-card\.reveal\.in:focus-visible\{transform:translateY\(-5px\) rotate\(var\(--poster-tilt\)\)/);
});

test('menu-card copy stays inside the printed sheet at intermediate widths',()=>{
  // Several .menu-card rules cascade; the poster-sheet rule is the one that sets the padding in force.
  const sheet=rules('.menu-card').find(body=>body.includes('--menu-poster:'));
  assert.ok(sheet,'poster-sheet .menu-card rule');
  assert.match(sheet,/padding:min\(13\.25%,clamp\(34px,5vw,55px\)\) min\(11\.6%,clamp\(30px,4\.4vw,48px\)\) min\(14%,clamp\(37px,5\.4vw,58px\)\)/);
  const start=source.indexOf('@media (min-width:621px) and (max-width:900px){');
  assert.notEqual(start,-1);
  const block=source.slice(start,source.indexOf('\n  }',start));
  assert.match(block,/#menu-preview \.menu-cards\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);max-width:760px\}/);
  assert.match(block,/#menu-preview \.menu-card--specials\{grid-column:1 \/ -1;justify-self:center;/);
});

test('Facebook images are never cropped or stretched',()=>{
  assert.match(rules('#social .fb-media img')[0],/object-fit:contain/);
});

test('rotated cards that hold text never carry a filter; the sheet and its shadow sit on a text-free layer',()=>{
  // Edge's GPU rasteriser drops text drawn inside an element that is both rotated and filtered
  // (reproduced in Edge 157: menu headings and posting dates unpainted while still in the DOM at
  // full opacity). The paper artwork and drop shadow therefore belong to ::before, never the card.
  const cardSelector=/(^|[\s,}])(#menu-preview |#social )?\.(menu-card|fb-card)(--[a-z]+|\.reveal\.in)?(:hover|:focus-visible)?$/;
  const styles=source.slice(source.indexOf('<style>'),source.lastIndexOf('</style>'));
  let checked=0;
  for(const [,selectors,body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
    for(const selector of selectors.split(',').map(part=>part.trim())){
      if(!cardSelector.test(selector)) continue;
      checked+=1;
      assert.doesNotMatch(body,/(^|;)\s*filter:/,`${selector} must not be filtered`);
    }
  }
  assert.ok(checked>=10,`expected to inspect the card rules, saw ${checked}`);
  for(const selector of ['.menu-card::before','#social .fb-card::before']){
    // An older .menu-card::before rule earlier in the cascade is overridden by the sheet rule.
    const sheet=rules(selector).find(body=>body.includes('inset:0'));
    assert.ok(sheet,`${selector} sheet rule`);
    assert.match(sheet,/content:"";/);
    assert.match(sheet,/position:absolute;z-index:-1;inset:0/);
    assert.match(sheet,/background:var\(--(menu-poster|poster-sheet)\) center \/ 100% 100% no-repeat/);
    assert.match(sheet,/filter:drop-shadow\(/);
  }
  assert.match(rules('#menu-preview .menu-card::before')[0],/filter:drop-shadow\(4px 14px 8px rgba\(7,3,1,\.7\)\)/);
  // The hover skirt on the poster sheet is padding the artwork is not painted into.
  assert.match(rules('#social .fb-card:hover::before')[0],/padding:4px 12px 10px;background-origin:content-box;background-clip:content-box/);
});
