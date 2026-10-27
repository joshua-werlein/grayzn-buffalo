// Run npm run build first: exercise the compiled production Astro pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';

const store=loadTs('src/lib/specials-store.ts');
const home=(await import('../dist/_worker.js/pages/index.astro.mjs')).page().default;
const specials=(await import('../dist/_worker.js/pages/specials.astro.mjs')).page().default;
const container=await AstroContainer.create();
const NativeDate=Date;
// Service labels with Astro's scoped attributes removed, in page order.
const labels=html=>[...html.matchAll(/<p class="special-group__label"[^>]*>([\s\S]*?)<\/p>/g)]
  .map(m=>m[1].replace(/<span[^>]*>/g,'<span>'));

test('homepage weekly cards show Lunch and Nightly service times exactly as the Specials page does',async t=>{
  const frozen='2026-10-26T17:00:00Z'; // Monday, October 26 in Chicago
  t.mock.method(globalThis,'Date',class extends NativeDate {
    constructor(...args){super(...(args.length?args:[frozen]));}
    static now(){return NativeDate.parse(frozen);}
  });
  const f=fixture(t);
  f.sql("UPDATE special_slots SET content='',price='',section_link=''");
  const draft=store.newWeekFromDefaults(await store.readCollection(f.env,'defaults'));
  for(const day of [1,6]) {
    const groups=draft.groups.filter(g=>g.day_of_week===day);
    groups.find(g=>g.service==='lunch').slots[0].content='3 Topping Personal Pizza & a Drink - $9.75';
    groups.find(g=>g.service==='all-day').slots[0].content='Cheeseburger w/ Fries $10.25';
    const nightly=groups.find(g=>g.service==='nightly');
    if(nightly?.enabled) nightly.slots[0].content='Prime Rib Dinner $18';
  }
  await store.saveCollection(f.env,draft,{start:'2026-10-26',end:'2026-11-01'});
  const render=(page,path)=>container.renderToString(page,{request:new Request('http://localhost'+path),locals:{runtime:{env:f.env}}});
  const homeHtml=await render(home,'/'), specialsHtml=await render(specials,'/specials');
  const homeLabels=labels(homeHtml.slice(homeHtml.indexOf('id="home-weekly-title"')));
  assert.deepEqual(homeLabels,[
    'Lunch<span>11 AM–1:30 PM</span>','All Day Specials','Nightly<span>5–10 PM</span>',
    // Saturday has no printed lunch window and no Nightly service.
    'Saturday Special','All Day Specials',
  ]);
  // Identical label + time markup (text, separators, element) to the Specials page.
  const specialsLabels=new Set(labels(specialsHtml));
  for(const label of homeLabels) assert.ok(specialsLabels.has(label),label);
  // The time stays inside the existing label row, never as a separate line or on All Day.
  assert.doesNotMatch(homeHtml,/All Day Specials<span/);
  assert.match(homeHtml,/3 Topping Personal Pizza &amp; a Drink - \$9\.75/);
});

test('homepage time styling reuses the shared label row and existing card tokens',()=>{
  const source=readFileSync('src/pages/index.astro','utf8');
  assert.match(source,/<SpecialGroup group=\{group\} showTime=\{group\.service !== 'all-day'\}/);
  assert.match(source.match(/\.home-weekly__card\{([^}]*)\}/)[1],/--sg-time:var\(--cream-2\)/);
  // The shared label wraps the time onto the next line in a narrow card instead of overflowing.
  assert.match(readFileSync('src/components/SpecialGroup.astro','utf8'),/\.special-group__label\{[^}]*flex-wrap:wrap/);
});
