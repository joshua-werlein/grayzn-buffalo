import test from 'node:test';
import assert from 'node:assert/strict';
import {GRAPH_API_VERSION,graphPostStatus} from './graph.js';

test('direct Graph lookup proves existence only for the exact requested post',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    calls.push({url:new URL(url),options});return Response.json({id:'123_456'});
  });
  assert.equal(await graphPostStatus({FB_SYSTEM_TOKEN:'test-only'},'123_456'),'exists');
  assert.equal(calls[0].url.pathname,`/${GRAPH_API_VERSION}/123_456`);
  assert.equal(calls[0].url.searchParams.get('fields'),'id');
  assert.equal(calls[0].url.searchParams.has('access_token'),false);
  assert.equal(calls[0].options.redirect,'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(await graphPostStatus({FB_SYSTEM_TOKEN:'test-only'},'123_789'),'unknown');
});

test('100/33 is unknown even when repeated after successful Page reads: it is not deletion evidence',async t=>{
  t.mock.method(globalThis,'fetch',async url=>new URL(url).pathname.endsWith('/feed')
    ? Response.json({data:[{id:'123_other'}]})
    : Response.json({error:{code:100,error_subcode:33,message:'Object does not exist, cannot be loaded due to missing permissions, or does not support this operation'}},{status:400}));
  for(let i=0;i<3;i++) {
    assert.ok((await (await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/123/feed`)).json()).data.length);
    assert.equal(await graphPostStatus({FB_SYSTEM_TOKEN:'test-only'},'123_456'),'unknown');
  }
});

test('404, revoked permissions, expiry, rate limits, server errors and invalid bodies stay unknown',async t=>{
  const responses=[
    ()=>Response.json({error:{code:100,error_subcode:33}},{status:404}),
    ()=>Response.json({error:{code:200}},{status:403}),
    ()=>Response.json({error:{code:190}},{status:400}),
    ()=>Response.json({error:{code:4}},{status:429}),
    ()=>new Response('',{status:503}),()=>new Response('not json'),()=>Response.json({data:[]}),
    ()=>Response.json({id:'other'}),()=>{throw new Error('mock network failure');},
    ()=>{throw new DOMException('mock timeout','TimeoutError');},
  ];
  let next;
  t.mock.method(globalThis,'fetch',async()=>next());
  for(next of responses) assert.equal(await graphPostStatus({FB_SYSTEM_TOKEN:'test-only'},'123_456'),'unknown');
});

test('invalid post IDs, absent credentials and invalid timeout make no Graph calls',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('unexpected Graph request'));
  for(const id of ['',null,'../123','123?access_token=x','x'.repeat(81)])
    assert.equal(await graphPostStatus({FB_SYSTEM_TOKEN:'test-only'},id),'unknown');
  assert.equal(await graphPostStatus({},'123_456'),'unknown');
  for(const timeoutMs of [0,-1,5001,NaN,1.5])
    assert.equal(await graphPostStatus({FB_SYSTEM_TOKEN:'test-only'},'123_456',{timeoutMs}),'unknown');
});
