import test from 'node:test';
import assert from 'node:assert/strict';
import server,{type Env} from '../src/server/index';
test('geospatial owner context stays available during storage pause without querying DB',async()=>{
 let dbCalls=0,fetchCalls=0;const original=globalThis.fetch;
 globalThis.fetch=async(input)=>{fetchCalls++;return String(input).includes('firms.modaps')?new Response('latitude,longitude,acq_date,acq_time,confidence,satellite,instrument\n'):new Response(JSON.stringify({results:[]}));};
 const env={DB:{prepare(){dbCalls++;throw Error('database must not be touched');}},ASSETS:{fetch:async()=>new Response('asset')},STORAGE_PAUSED:'1',EUROPE_WATCH_OWNER_TOKEN:'owner',EUROPE_WATCH_WORKER_TOKEN:'worker',EUROPE_WATCH_COLLECTOR_TOKEN:'collector'} as unknown as Env;
 try{for(const [token,status]of [['',401],['worker',403],['collector',403]]){const r=await server.fetch(new Request('https://example.invalid/api/geospatial',{headers:{authorization:'Bearer '+token}}),env);assert.equal(r.status,status);}assert.equal(fetchCalls,0);const owner=await server.fetch(new Request('https://example.invalid/api/geospatial',{headers:{authorization:'Bearer owner'}}),env);assert.equal(owner.status,200);assert.equal(owner.headers.get('x-ew-rows-read'),'0');const data=await owner.json() as any;assert.equal(data.sources.length,2);assert.equal(dbCalls,0);assert.equal(fetchCalls,2);}finally{globalThis.fetch=original;}
});
