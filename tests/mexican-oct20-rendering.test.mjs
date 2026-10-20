import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
const store=loadTs('src/lib/specials-store.ts');
const page=(await import('../dist/_worker.js/pages/specials.astro.mjs')).page().default;
const {manifest}=await import('../dist/_worker.js/'+readdirSync('dist/_worker.js').find(n=>/^manifest_.*\.mjs$/.test(n)));
test('October 20 compiled page renders canonical headings, labelled prices and one advisory',async t=>{
  const f=fixture(t),menu=await store.readCollection(f.env,'mexican-night');
  const rows=JSON.parse(readFileSync('tests/fixtures/mexican-recurring-prices.json','utf8'));
  menu.title="TONIGHT @ GRAYZ'N BUFFALO 5-10PM MEXICAN NIGHT EVERY TUESDAY NIGHT 5-10PM";
  menu.schedule='Every Tuesday Night 5-10pm';
  menu.groups=['Favorites','More','Substitutions & Add-ons'].map((label,i)=>{
    const g=store.blankGroup(-1,i);g.label=label;g.service_time='5–10 PM';
    const items=i===0?rows.slice(0,4):i===1?rows.slice(4,7):rows.slice(7);
    g.slots.forEach((slot,j)=>slot.content=items[j]?.[0]??'');return g;
  });
  await store.saveCollection(f.env,menu);
  f.sql("UPDATE special_collections SET updated_at='2026-10-20T14:00:00Z' WHERE id='mexican-night'");
  const container=await AstroContainer.create();
  let html=await container.renderToString(page,{request:new Request('http://localhost/specials'),locals:{runtime:{env:f.env,now:new Date('2026-10-20T15:00:00Z')}}});
  assert.match(html,/>Mexican Night<\/h2>/);assert.doesNotMatch(html,/TONIGHT @|EVERY TUESDAY NIGHT/);
  assert.match(html,/Every Tuesday • 5–10 PM/);
  assert.match(html,/Large \$9.00 · Small \$8.50 · Mini \$6.00/);
  assert.equal((html.match(/id="mexican-favorites-heading"/g)||[]).length,1);
  assert.equal((html.match(/Consuming raw or undercooked/g)||[]).length,1);
  assert.doesNotMatch(html,/<p[^>]*>5–10 PM<\/p>/);
  const css=readFileSync('src/components/MexicanNightMenu.astro','utf8');
  assert.match(css,/clamp\(1.1rem,2vw,1.4rem\)\/1.5/);
  if(process.env.MEXICAN_LAYOUT_PREVIEW==='1') {
    const route=manifest.routes.find(r=>r.routeData.route==='/specials');
    html=html.replace('</head>',route.styles.map(s=>s.type==='external'?`<link rel="stylesheet" href="${s.src}">`:`<style>${s.content}</style>`).join('')+'</head>');
    mkdirSync('.wrangler/mexican-layout',{recursive:true});
    writeFileSync('.wrangler/mexican-layout/menu.html',html);
    writeFileSync('.wrangler/mexican-layout/index.html',readFileSync('tests/fixtures/mexican-layout.html','utf8'));
  }
});
