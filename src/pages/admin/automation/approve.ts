import type {APIRoute} from 'astro';
import {isAuthed} from '../../../lib/auth';
import {approveImport} from '../../../lib/automation-approval';
import {SpecialConflict} from '../../../lib/specials-store';

export const POST: APIRoute=async({request,cookies,locals,url})=>{
  const env=(locals as any).runtime?.env??{};
  const reply=(value: any,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  if(!await isAuthed(cookies,env)) return reply({error:'Sign in again before approving specials.'},401);
  if(request.headers.get('origin')!==url.origin || request.headers.get('sec-fetch-site')==='cross-site') return reply({error:'Invalid request origin.'},403);
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json') return reply({error:'Expected an approval request.'},415);
  try {
    const reader=request.body?.getReader();
    if(!reader) throw Error('Missing request.');
    const chunks: Uint8Array[]=[];let size=0;
    while(true) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64000){await reader.cancel();return reply({error:'Approval request is too large.'},413);}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const body=JSON.parse(new TextDecoder().decode(bytes));
    if(!['preview','publish'].includes(body.mode)) throw Error('Invalid approval action.');
    const result=await approveImport(env,body.input,(locals as any).runtime?.now??new Date(),{preview:body.mode==='preview'});
    return reply({ok:true,...result});
  } catch(error) {
    console.error('Staff approval rejected',error instanceof SpecialConflict?'concurrent change':'validation or storage error');
    return reply({error:error instanceof SpecialConflict?error.message:error instanceof Error && !/SQL|D1_|sqlite|database|no such|constraint/i.test(error.message)?error.message:'Approval could not be saved. Your draft is preserved; reload the saved values before retrying.'},error instanceof SpecialConflict?409:400);
  }
};
export const ALL: APIRoute=()=>new Response('Method not allowed',{status:405,headers:{Allow:'POST','Cache-Control':'no-store'}});
