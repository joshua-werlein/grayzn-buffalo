// Compiled Astro 7 / @astrojs/cloudflare 14 output. Run npm run build first.
// Server chunks are content-hashed, so pages are found by their source path.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const CHUNKS = 'dist/server/chunks';
export const CLIENT_ASSETS = 'dist/client/_astro';

const chunkNames = () => readdirSync(CHUNKS).filter(name => name.endsWith('.mjs'));
const importChunk = name => import(new URL(`../${CHUNKS}/${name}`, import.meta.url).href);

/** Default export of a compiled page, e.g. builtPage('src/pages/specials.astro'). */
export async function builtPage(source) {
  const marker = 'virtual:astro:page:' + source.replace(/\.(astro|ts)$/, '@_@$1');
  const name = chunkNames().find(n => readFileSync(`${CHUNKS}/${n}`, 'utf8').includes(marker));
  if (!name) throw new Error(`No compiled chunk for ${source}; run npm run build first`);
  return (await importChunk(name)).page().default;
}

/** Compiled component, e.g. builtComponent('SpecialGroup'). */
export async function builtComponent(component) {
  for (const name of chunkNames().filter(n => readFileSync(`${CHUNKS}/${n}`, 'utf8').includes(`/${component}.astro`))) {
    const found = Object.values(await importChunk(name)).find(c => c?.moduleId?.endsWith(`/${component}.astro`));
    if (found) return found;
  }
  throw new Error(`No compiled component ${component}; run npm run build first`);
}

/** Serialized route manifest (styles/scripts per route) for the preview fixtures.
 *  The server entry imports cloudflare:workers, so it is read as text, not imported. */
export function builtManifest() {
  const entry = readFileSync('dist/server/entry.mjs', 'utf8');
  const start = entry.indexOf('{', entry.indexOf('= deserializeManifest('));
  let depth = 0, inString = false;
  for (let i = start; i < entry.length; i++) {
    const ch = entry[i];
    if (inString) { if (ch === '\\') i++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(entry.slice(start, i + 1));
  }
  throw new Error('No serialized manifest in dist/server/entry.mjs');
}

/** The same compiled route exports previously returned by Pages page(). */
export async function builtRoute(name) {
  let source = name.startsWith('src/') ? name : 'src/pages/' + (name === 'admin' ? 'admin/index' : name);
  if (!/\.(astro|ts)$/.test(source)) source += existsSync(source + '.astro') ? '.astro' : '.ts';
  const marker = 'virtual:astro:page:' + source.replace(/\.(astro|ts)$/, '@_@$1');
  const nameInBuild = chunkNames().find(n => readFileSync(CHUNKS + '/' + n, 'utf8').includes(marker));
  if (!nameInBuild) throw new Error('No compiled route for ' + source);
  return (await importChunk(nameInBuild)).page();
}
