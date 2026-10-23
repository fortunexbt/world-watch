import test from 'node:test';
import assert from 'node:assert/strict';
import server,{type Env} from '../src/server/index';
import {FIRMS_SENSORS} from '../src/server/geospatial';
// One CEMS list read and one file per sensor still delivering.
const reads=()=>1+FIRMS_SENSORS.filter(s=>!s.ended||Date.parse(s.ended.at)>Date.now()).length;
test('geospatial owner context stays available during storage pause without querying DB',async()=>{
 let dbCalls=0,fetchCalls=0;const original=globalThis.fetch;
 globalThis.fetch=async(input)=>{fetchCalls++;return String(input).includes('firms.modaps')?new Response('latitude,longitude,acq_date,acq_time,confidence,satellite,instrument\n'):new Response(JSON.stringify({results:[]}));};
 const env={DB:{prepare(){dbCalls++;throw Error('database must not be touched');}},ASSETS:{fetch:async()=>new Response('asset')},STORAGE_PAUSED:'1',EUROPE_WATCH_OWNER_TOKEN:'owner',EUROPE_WATCH_WORKER_TOKEN:'worker',EUROPE_WATCH_COLLECTOR_TOKEN:'collector'} as unknown as Env;
 const get=(token:string,query='')=>server.fetch(new Request('https://example.invalid/api/geospatial'+query,{headers:{authorization:'Bearer '+token}}),env);
 try{for(const [token,status]of [['',401],['worker',403],['collector',403]]){const r=await get(String(token));assert.equal(r.status,status);}assert.equal(fetchCalls,0);
  for(const bad of ['?bbox=1,2,3','?bbox=0,10,10,5','?bbox=']){const r=await get('owner',bad);assert.equal(r.status,400);assert.deepEqual(await r.json(),{error:'invalid_bbox'});}assert.equal(fetchCalls,0);
  const owner=await get('owner');assert.equal(owner.status,200);assert.equal(owner.headers.get('x-ew-rows-read'),'0');const data=await owner.json() as any;assert.deepEqual(data.bbox,[-180,-90,180,90]);assert.equal(data.sources.length,2);assert.equal(data.sources[1].sensors.length,3);assert.equal(dbCalls,0);assert.equal(fetchCalls,reads());
  const pacific=await (await get('owner','?bbox=170,-50,-170,0')).json() as any;assert.deepEqual(pacific.bbox,[170,-50,-170,0]);assert.equal(fetchCalls,reads());}finally{globalThis.fetch=original;}
});
test('thermal tiles are owner-only, bounded to the tile pyramid and cached per FIRMS refresh',async()=>{
 const original=globalThis.fetch;const at=new Date(Date.now()-3600000).toISOString();
 globalThis.fetch=async(input)=>String(input).includes('firms.modaps')?new Response(`latitude,longitude,acq_date,acq_time,satellite,confidence\n-17.8,179.5,${at.slice(0,10)},${at.slice(11,13)+at.slice(14,16)},N20,high\n`):new Response(JSON.stringify({results:[]}));
 const env={DB:{prepare(){throw Error('database must not be touched');}},ASSETS:{fetch:async()=>new Response('asset')},STORAGE_PAUSED:'1',EUROPE_WATCH_OWNER_TOKEN:'owner',EUROPE_WATCH_WORKER_TOKEN:'worker',EUROPE_WATCH_COLLECTOR_TOKEN:'collector'} as unknown as Env;
 const get=(path:string,token='owner')=>server.fetch(new Request('https://example.invalid'+path,{headers:{authorization:'Bearer '+token}}),env);
 try{
  for(const [token,status] of [['',401],['worker',403]] as const)assert.equal((await get('/api/thermal/v1/0/0/0',token)).status,status);
  for(const bad of ['/api/thermal/v1/10/0/0','/api/thermal/v1/2/4/0','/api/thermal/v1/2/0/4'])assert.deepEqual(await (await get(bad)).json(),{error:'invalid_tile'});
  const {thermal_version}=await (await get('/api/geospatial')).json() as any;
  const tile=await get(`/api/thermal/${thermal_version}/0/0/0`);
  assert.equal(tile.status,200);assert.equal(tile.headers.get('content-type'),'application/x-protobuf');
  assert.equal(tile.headers.get('cache-control'),'private, max-age=86400, immutable');
  assert(new Uint8Array(await tile.arrayBuffer()).length>0);
  const empty=await get(`/api/thermal/${thermal_version}/1/0/0`);assert.equal(empty.status,204);
  // A client still holding an older version gets the current tiles, never cached under the old name.
  const stale=await get('/api/thermal/old/0/0/0');assert.equal(stale.status,200);assert.equal(stale.headers.get('cache-control'),'no-store');
 }finally{globalThis.fetch=original;}
});
