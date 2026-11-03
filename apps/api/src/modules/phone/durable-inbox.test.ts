import {it,expect,vi} from 'vitest';
import {createApp} from '../../app.js';

const org='a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
it('never silently falls back to process memory when durable phone storage is unavailable',async()=>{
 const app=createApp({auth:{getUser:async()=>({userId:org})} as never,organizations:{requireAccess:async()=> 'member'} as never,customers:{search:async()=>({items:[{id:org,organization_id:org,name:'고객',phone:'01012345678',status:'active'}],total:1})} as never,activities:{} as never});
 const response=await app.inject({method:'POST',url:`/api/v1/organizations/${org}/mobile/incoming-calls`,headers:{authorization:'Bearer test'},payload:{event_id:org,number:'01012345678',occurred_at:new Date().toISOString()}});
 expect(response.statusCode).toBe(503);
 await app.close();
});
it('bounds simultaneous database polls per receiver and releases listener slots after failures',async()=>{
 let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});let reads=0;
 const app=createApp({auth:{getUser:async()=>({userId:org})} as never,organizations:{requireAccess:async()=> 'member'} as never,customers:{search:async()=>({items:[],total:0})} as never,activities:{} as never,phone:{request:async()=>{reads++;await hold;return {items:[],cursor:'v1:scope:0'};}}});
 const request=()=>app.inject({url:`/api/v1/organizations/${org}/mobile/incoming-calls?wait_ms=0`,headers:{authorization:'Bearer user'}});
 const pending=Array.from({length:4},()=>request().then(r=>r.statusCode));await vi.waitFor(()=>expect(reads).toBe(4));
 expect((await request()).statusCode).toBe(429);release();expect(await Promise.all(pending)).toEqual([200,200,200,200]);expect((await request()).statusCode).toBe(200);await app.close();
});
it('exposes a bounded authenticated durable inbox and separate retention consent',async()=>{
 const calls:unknown[]=[];
 const app=createApp({auth:{getUser:async()=>({userId:org})} as never,organizations:{requireAccess:async()=> 'member'} as never,customers:{search:async()=>({items:[],total:0})} as never,activities:{} as never,phone:{request:async(...args:unknown[])=>{calls.push(args);return {enabled:false,version:0,retention_days:30};}} as never} as never);
 const path=`/api/v1/organizations/${org}/phone/retention-consent`;
 expect((await app.inject({url:path})).statusCode).toBe(401);
 expect((await app.inject({url:path,headers:{authorization:'Bearer user'}})).json()).toMatchObject({enabled:false,version:0,retention_days:30});
 expect(calls).toEqual([['user',org,'consent',{}]]);
 expect((await app.inject({url:`/api/v1/organizations/${org}/phone/inbox?limit=501`,headers:{authorization:'Bearer user'}})).statusCode).toBe(422);
 await app.close();
});
