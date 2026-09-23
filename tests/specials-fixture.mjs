import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'grayzn-specials-'));
  const path=join(dir,'test.sqlite');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  function execute(input) {
    const result=spawnSync('python',['tests/sqlite-specials.py'],{input:JSON.stringify({path,...input}),encoding:'utf8'});
    if(result.status!==0) throw new Error(result.stdout || result.stderr);
    return JSON.parse(result.stdout);
  }
  execute({initialize:true});
  const sql=(query,...args)=>execute({statements:[{sql:query,args}]})[0].results;
  const env={ DB:{prepare(query) {
    const statement={sql:query,args:[]};
    return { ...statement, bind(...args) { return {sql:query,args,
      async all(){return execute({statements:[{sql:query,args}]})[0]},
      async first(){return sql(query,...args)[0] ?? null},
      async run(){return execute({statements:[{sql:query,args}]})[0]},
    }},async all(){return execute({statements:[statement]})[0]},async first(){return sql(query)[0]??null} };
  },async batch(statements){return execute({statements})}}};
  return {env,sql,execute,path};
}
