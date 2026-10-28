import type {APIRoute} from 'astro';
import {isAuthed} from '../../../lib/auth';
import {dismissImport,restoreImport,DismissConflict} from '../../../lib/automation-dismissal';

export const POST: APIRoute=async({request,cookies,locals,url})=>{
  const env=(locals as any).runtime?.env??{};
  const reply=(value: any,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  if(!await isAuthed(cookies,env)) return reply({error:'Sign in again before changing your review list.'},401);
  if(request.headers.get('origin')!==url.origin || request.headers.get('sec-fetch-site')==='cross-site') return reply({error:'Invalid request origin.'},403);
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json') return reply({error:'Expected a review list request.'},415);
  try {
    const reader=request.body?.getReader();
    if(!reader) throw Error('Missing request.');
    const chunks: Uint8Array[]=[];let size=0;
    while(true) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2000){await reader.cancel();return reply({error:'Request is too large.'},413);}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const body=JSON.parse(new TextDecoder().decode(bytes));
    if(!['dismiss','restore'].includes(body?.action)) throw Error('Invalid action.');
    const now=(locals as any).runtime?.now??new Date();
    return reply({ok:true,...(body.action==='dismiss'?await dismissImport(env,body,now):await restoreImport(env,body,now))});
  } catch(error) {
    console.error('Staff dismissal rejected',error instanceof DismissConflict?'concurrent change':'validation or storage error');
    return reply({error:error instanceof Error && !/SQL|D1_|sqlite|database|no such|constraint|JSON/i.test(error.message)?error.message:'That didn’t work. Nothing was changed; reload and try again.'},error instanceof DismissConflict?409:400);
  }
};
export const ALL: APIRoute=()=>new Response('Method not allowed',{status:405,headers:{Allow:'POST','Cache-Control':'no-store'}});
