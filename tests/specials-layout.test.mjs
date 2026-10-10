import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {experimental_AstroContainer as AstroContainer} from 'astro/container';
import {fixture} from './specials-fixture.mjs';
import {loadTs} from './load-ts.mjs';
import {withSoupControls,isSoupGroup} from '../src/lib/daily-soup.js';

const store=loadTs('src/lib/specials-store.ts');
const home=(await import('../dist/_worker.js/pages/index.astro.mjs')).page().default;
const specials=(await import('../dist/_worker.js/pages/specials.astro.mjs')).page().default;
const container=await AstroContainer.create();
const {manifest}=await import('../dist/_worker.js/'+readdirSync('dist/_worker.js').find(n=>/^manifest_.*\.mjs$/.test(n)));
const NativeDate=Date;
const meals=JSON.parse(readFileSync('tests/fixtures/oct10-saturday.json','utf8')).offers.slice(0,3).map(o=>o.content);
const soup='French Onion, Chili or Beer Cheese Soup';

for(const day of [6,4]) for(const hasSoup of [false,true])
  test(`${day===6?'Saturday two-group':'Thursday three-group'} layout separates food and ${hasSoup?'Soup':'no Soup'} on both pages`,async t=>{
    const frozen=day===6?'2026-10-10T17:00:00Z':'2026-10-08T17:00:00Z';
    t.mock.method(globalThis,'Date',class extends NativeDate {
      constructor(...args){super(...(args.length?args:[frozen]));}
      static now(){return NativeDate.parse(frozen);}
    });
    const f=fixture(t);
    f.sql("UPDATE special_slots SET content='',price='',section_link=''");
    const defaults=await store.readCollection(f.env,'defaults');
    const draft=withSoupControls(store.newWeekFromDefaults(defaults));
    // Populate both days so Thursday also verifies the Saturday rest-of-week card.
    for(const d of [4,6]) {
      const groups=draft.groups.filter(g=>g.day_of_week===d);
      groups.find(g=>g.service==='lunch').slots[0].content=meals[0];
      const allDay=groups.find(g=>g.service==='all-day');
      allDay.slots[0].content=meals[1];allDay.slots[1].content=meals[2];
      if(d===4)groups.find(g=>g.service==='nightly').slots[0].content='12” 3-Topping Pizza $13.50';
      if(hasSoup)groups.find(isSoupGroup).slots[0].content=soup;
    }
    await store.saveCollection(f.env,draft,{start:'2026-10-05',end:'2026-10-11'});
    for(const [name,page,path] of [['home',home,'/'],['specials',specials,'/specials']]) {
      const html=await container.renderToString(page,{request:new Request('http://localhost'+path),locals:{runtime:{env:f.env}}});
      const articles=[...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].map(m=>m[0]);
      const today=articles.find(a=>/home-weekly__day[^>]*is-today|placard--today/.test(a));
      assert.ok(today);
      assert.equal((today.match(/class="special-group"/g)||[]).length,day===6?2:3);
      assert.equal((today.match(/class="daily-soup"/g)||[]).length,hasSoup?1:0);
      assert.match(today,name==='home'?/class="home-weekly__food"/:/class="today-food"/);
      if(hasSoup) {
        assert.ok(today.lastIndexOf('</section>')<today.indexOf('class="daily-soup"'));
        assert.match(today,/<\/section>\s*<\/div>\s*<p class="daily-soup"/);
      }
      if(name==='specials' && day===4) {
        const saturday=articles.find(a=>/datetime="2026-10-10"/.test(a));
        assert.ok(saturday);assert.match(saturday,/class="card-food"/);
        assert.equal((saturday.match(/class="special-group"/g)||[]).length,2);
        if(hasSoup)assert.match(saturday,/<\/section>\s*<\/div>\s*<p class="daily-soup"/);
      }
      // Optional full-page fixtures for real-browser breakpoint checks, using
      // compiled production CSS and disposable local SQLite test data only.
      if(process.env.SPECIALS_LAYOUT_PREVIEW==='1') {
        mkdirSync('.wrangler/specials-layout',{recursive:true});
        const route=manifest.routes.find(r=>r.routeData.route===path);
        const styles=route.styles.map(s=>s.type==='external'?`<link rel="stylesheet" href="${s.src}">`:`<style>${s.content}</style>`).join('');
        const scripts=route.scripts.map(s=>s.type==='external'?`<script type="module" src="${s.src}"></script>`:`<script type="module">${s.content}</script>`).join('');
        const preview=html.replace(/src="(?:file:|[A-Za-z]:)[^"]+\/([^/?.]+)\.astro\?[^"]+"/g,(source,component)=>{
          const asset=readdirSync('dist/_astro').find(n=>n.startsWith(`${component}.astro_astro_type_script_index_0_`) && n.endsWith('.js'));
          assert.ok(asset,`Missing compiled script for ${component}`);
          return `src="/_astro/${asset}"`;
        }).replace('</head>',styles+'</head>').replace('</body>',scripts+'</body>');
        writeFileSync(`.wrangler/specials-layout/${name}-${day}-${hasSoup?'soup':'plain'}.html`,preview);
      }
    }
  });
