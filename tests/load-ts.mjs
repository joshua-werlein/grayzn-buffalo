import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';

// Use the repository's existing TypeScript dependency; no generated files.
export function loadTs(path) {
  const filename = resolve(path);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const require = id => {
    if (id === 'astro:middleware') return { defineMiddleware: handler => handler };
    const sibling = resolve(dirname(filename), id.endsWith('.js') ? id : id + '.ts');
    return id.startsWith('.') && existsSync(sibling) ? loadTs(sibling) : localRequire(id);
  };
  new Function('exports', 'require', 'module', code)(module.exports, require, module);
  return module.exports;
}
