import test from 'node:test';
import assert from 'node:assert/strict';
import server,{type Env} from '../src/server/index';
test('geospatial owner context stays available during storage pause without querying DB',async()=>{
 let dbCalls=0,fetchCalls=0;const original=globalThis.fetch;
 globalThis.fetch=async(input)=>{fetchCalls++;return String(input).includes('firms.modaps')?new Response('latitude,longitude,acq_date,acq_time,confidence,satellite,instrument\n'):new Response(JSON.stringify({results:[]}));};
 const env={DB:{prepare(){dbCalls++;throw Error('database must not be touched');}},ASSETS:{fetch:async()=>new Response('asset')},STORAGE_PAUSED:'1',EUROPE_WATCH_OWNER_TOKEN:'owner',EUROPE_WATCH_WORKER_TOKEN:'worker',EUROPE_WATCH_COLLECTOR_TOKEN:'collector'} as unknown as Env;
 const get=(token:string,query='')=>server.fetch(new Request('https://example.invalid/api/geospatial'+query,{headers:{authorization:'Bearer '+token}}),env);
 try{for(const [token,status]of [['',401],['worker',403],['collector',403]]){const r=await get(String(token));assert.equal(r.status,status);}assert.equal(fetchCalls,0);
  for(const bad of ['?bbox=1,2,3','?bbox=0,10,10,5','?bbox=']){const r=await get('owner',bad);assert.equal(r.status,400);assert.deepEqual(await r.json(),{error:'invalid_bbox'});}assert.equal(fetchCalls,0);
  const owner=await get('owner');assert.equal(owner.status,200);assert.equal(owner.headers.get('x-ew-rows-read'),'0');const data=await owner.json() as any;assert.deepEqual(data.bbox,[-180,-90,180,90]);assert.equal(data.sources.length,2);assert.equal(data.sources[1].sensors.length,3);assert.equal(dbCalls,0);assert.equal(fetchCalls,4);
  const pacific=await (await get('owner','?bbox=170,-50,-170,0')).json() as any;assert.deepEqual(pacific.bbox,[170,-50,-170,0]);assert.equal(fetchCalls,4);}finally{globalThis.fetch=original;}
});
