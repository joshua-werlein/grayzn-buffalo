import { runtimeEnv } from '../../../lib/runtime-env';
import type {APIRoute} from 'astro';
import {isAuthed} from '../../../lib/auth';
import {approveWingImport} from '../../../lib/wing-approval';
import {SpecialConflict} from '../../../lib/specials-store';

export const POST: APIRoute=async({request,cookies,locals,url})=>{
  const env=runtimeEnv(locals);
  const reply=(value: any,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  if(!await isAuthed(cookies,env)) return reply({error:'Sign in again before approving.'},401);
  if(request.headers.get('origin')!==url.origin || request.headers.get('sec-fetch-site')==='cross-site') return reply({error:'Invalid request origin.'},403);
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json') return reply({error:'Expected an approval request.'},415);
  try {
    const text=await request.text();
    if(text.length>4000) return reply({error:'Request is too large.'},413);
    return reply({ok:true,...await approveWingImport(env,JSON.parse(text))});
  } catch(error) {
    const conflict=error instanceof SpecialConflict;
    return reply({error:error instanceof Error && !/SQL|D1_|sqlite|database|no such|constraint|JSON/i.test(error.message)?error.message:'That didn’t work. Nothing was changed; reload and try again.'},conflict?409:400);
  }
};
export const ALL: APIRoute=()=>new Response('Method not allowed',{status:405,headers:{Allow:'POST','Cache-Control':'no-store'}});
