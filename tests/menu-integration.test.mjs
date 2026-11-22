import { adminSessionEnv } from './admin-session-fixture.mjs';
import {builtRoute} from './built-output.mjs';
// Integration-only regressions: real isolated SQLite, compiled pages, no production bindings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
const container=await AstroContainer.create();
const admin=(await builtRoute('admin/menu')).default;
const menu=(await builtRoute('menu')).default;
const { GET: menuFeed } = await builtRoute('menu.json');
const baseline=JSON.parse(readFileSync('src/data/menu-baseline.json','utf8'));
function fixture(t){
 const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
 db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 const schema=readFileSync('schema.sql','utf8');
 for(const table of ['categories','items']){db.exec(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0]); for(const row of baseline[table]){const keys=Object.keys(row);db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row));}}
 const env={...adminSessionEnv(),DB:{prepare(sql){const q=args=>({sql,args,bind:(...a)=>q(a),first:async()=>db.prepare(sql).get(...args)??null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>{const r=db.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}}}});return q([])},async batch(statements){db.exec('BEGIN');try{const out=[];for(const s of statements){const st=db.prepare(s.sql);out.push(/^\s*SELECT/i.test(s.sql)?{results:st.all(...s.args)}:{meta:{changes:Number(st.run(...s.args).changes)}})}db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}}}};
 return {db,env};
}
const request=(f,path,init={})=>({request:new Request('http://localhost'+path,{...init,headers:{cookie:'gb_session='+ 'a'.repeat(32),origin:'http://localhost',...(init.headers??{})}}),locals:{runtime:{env:f.env}}});
const load=(f,page=admin)=>container.renderToString(page,request(f,page===menu?'/menu':'/admin/menu'));
const post=(f,fields,json=false)=>{const body=new FormData();for(const [k,v]of Object.entries(fields))for(const val of [v].flat())body.append(k,String(val));return container.renderToResponse(admin,request(f,'/admin/menu',{method:'POST',body,headers:json?{accept:'application/json'}:{}}))};
const value=(f,key)=>f.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;

test('recovery SQL reproduces the menu snapshot and rejects a populated target', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync('schema.sql', 'utf8'));
    const sql = readFileSync('recovery/menu-canonical.sql', 'utf8');
    db.exec(`BEGIN; ${sql} COMMIT;`);
    for (const [table, order] of [['categories', 'sort, id'], ['items', 'category_id, sort, id']]) {
      const columns = Object.keys(baseline[table][0]).join(', ');
      const restored = db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${order}`).all();
      assert.deepEqual(restored.map(row => ({ ...row })), baseline[table]);
    }
    assert.throws(() => db.exec(`BEGIN; ${sql} COMMIT;`), /CHECK constraint failed/);
    db.exec('ROLLBACK;');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM items').get().count, baseline.items.length);
  } finally {
    db.close();
  }
});

test('the public menu and feed use the refreshed price-free snapshot when D1 is unavailable', async t => {
  const live = fixture(t);
  const outage = { env: { DB: { prepare() { throw new Error('D1 unavailable'); } } } };
  const readFeed = async f => {
    const response = await menuFeed(request(f, '/menu.json'));
    assert.equal(response.status, 200);
    return response.json();
  };
  const expected = await readFeed(live);
  assert.deepEqual(await readFeed(outage), expected);
  assert.match(JSON.stringify(expected), /10pc Shrimp Basket/);
  assert.match(JSON.stringify(expected), /On the Lighter Side/);
  assert.doesNotMatch(JSON.stringify(expected), /"(?:price|priceCurrency)"\s*:|\$\s*\d/i);
  const offlineMenu = await load(outage, menu);
  assert.match(offlineMenu, /10pc Shrimp Basket/);
  assert.match(offlineMenu, /On the Lighter Side/);
  const itemText = offlineMenu.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  assert.doesNotMatch(itemText, /\$\s*\d/);
});
for(const [action,key,fields,changed]of[
 ['wrap-options','menu_wrap_options',{wrap_notes:'Original wrap note.'},{wrap_notes:'New wrap note.'}],
 ['salad-options','menu_salad_options',{salad_dressings:'Ranch',salad_greens:'Iceberg'},{salad_dressings:'French',salad_greens:'Spinach Mix'}],
 ['substitute-sides','menu_substitute_sides',{substitute_sides:'Fries'},{substitute_sides:'Tots'}],
 ['pizza-options','menu_pizza_options',{pizza_sizes:['6"'],pizza_crusts:['Thin'],pizza_toppings:'Sausage'},{pizza_sizes:['12"'],pizza_crusts:['Regular'],pizza_toppings:'Pepperoni'}],
])test(`${action}: a stale staff form preserves its draft and cannot overwrite newer options`,async t=>{
 const f=fixture(t);assert.equal((await post(f,{action,...fields,options_snapshot:''})).status,303);
 const old=value(f,key);assert.equal((await post(f,{action,...changed,options_snapshot:old})).status,303);
 const current=value(f,key);const failed=await post(f,{action,...fields,options_snapshot:old});const html=await failed.text();
 assert.match(html,/Someone else changed these options/);assert.equal(value(f,key),current);
 assert.ok(html.includes('options_snapshot'));assert.equal((await post(f,{action,...fields})).status,200);assert.equal(value(f,key),current);
});
for(const [field,key]of [['sauces','menu_sauces_sort'],['sides','menu_substitute_sides_sort']])test(`${field}: stale ordering rolls back category and virtual-section changes together`,async t=>{
 const f=fixture(t);const cat=baseline.categories[0];
 const fields={action:'reorder-sections',[`sort_${field}`]:2,[`sort_${field}_was`]:9,[`sort_${field}_snapshot`]:'',[`sort_${cat.id}`]:40,[`was_${cat.id}`]:cat.sort};
 f.db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run(key,'3');
 const response=await post(f,fields);assert.equal(response.headers.get('location'),'/admin/menu?sm=e10');assert.equal(value(f,key),'3');assert.equal(f.db.prepare('SELECT sort FROM categories WHERE id=?').get(cat.id).sort,cat.sort);
});
test('Wraps links preserve wording, use unique destinations on both tabs, and never link to an empty section',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE items SET late_night=1 WHERE category_id=(SELECT id FROM categories WHERE name='Wraps')").run();
 let html=await load(f,menu);assert.equal((html.match(/href="#menu-substitute-sides" data-sides-link/g)??[]).length,2);
 f.db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('menu_substitute_sides',JSON.stringify({sides:['Fries'],lateNight:true}));
 html=await load(f,menu);assert.match(html,/href="#late-menu-substitute-sides" data-sides-link/);assert.equal((html.match(/id="menu-substitute-sides"/g)??[]).length,1);assert.equal((html.match(/id="late-menu-substitute-sides"/g)??[]).length,1);
 for(const tab of ['daily','late-night']){const start=html.indexOf(`id="panel-${tab}"`);assert.ok(html.slice(start).includes('All Wraps Served with Chips and a Pickle.'));}
 f.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({sides:[],lateNight:true}),'menu_substitute_sides');html=await load(f,menu);assert.doesNotMatch(html,/data-sides-link/);assert.ok(html.includes('See Substitute Sides.'));
});
test('deleting an already deleted item reports an error, never success',async t=>{
 const f=fixture(t);f.db.prepare('DELETE FROM items WHERE id=?').run(baseline.items[0].id);const r=await post(f,{action:'delete',id:baseline.items[0].id},true);assert.equal(r.status,500);assert.equal((await r.json()).ok,false);
});

test('option display values and save tokens share one snapshot even when another staff member saves during page load',async t=>{
 const f=fixture(t);
 const old=JSON.stringify({sizes:['6"'],crusts:['Thin'],toppings:['Sausage']});
 const newer=JSON.stringify({sizes:['16"'],crusts:['Deep Dish'],toppings:['Pepperoni']});
 f.db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('menu_pizza_options',old);
 const prepare=f.env.DB.prepare.bind(f.env.DB);
 f.env.DB.prepare=sql=>{
  const statement=prepare(sql);
  if(!sql.startsWith('SELECT key, value FROM settings'))return statement;
  const bind=statement.bind;
  statement.bind=(...args)=>{const bound=bind(...args);const all=bound.all;bound.all=async()=>{const result=await all();f.db.prepare('UPDATE settings SET value=? WHERE key=?').run(newer,'menu_pizza_options');return result};return bound};
  return statement;
 };
 const html=await load(f);const panel=html.slice(html.indexOf('id="pizza-options"'),html.indexOf('id="wrap-options"')).replaceAll('&quot;', '&#34;');
 assert.match(panel,/value="6&#34;" checked/);assert.doesNotMatch(panel,/value="16&#34;" checked/);
 assert.ok(panel.includes(old.replace(/"/g,'&#34;')));
 const response=await post(f,{action:'pizza-options',pizza_sizes:['12"'],pizza_crusts:['Regular'],pizza_toppings:'Bacon',options_snapshot:old});
 assert.match(await response.text(),/Someone else changed these options/);assert.equal(value(f,'menu_pizza_options'),newer);
});
