import {it,expect,vi} from 'vitest';
import {createApp} from '../../app.js';
const org='a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const headers={authorization:'Bearer user'};
const result={organization_id:org,mode:'delta',items:[],revision:'0',next_cursor:null,cursor:'signed-checkpoint',reset_required:false};
function app(request: (...args: unknown[])=>Promise<unknown>) {return createApp({auth:{getUser:async()=>({userId:org})} as never,organizations:{requireAccess:async()=> 'member'} as never,customers:{search:async()=>({items:[],total:0})} as never,activities:{} as never,phone:{request} as never});}
it('serves incremental directory via authorized bounded RPC without legacy full search',async()=>{
 const request=vi.fn(async()=>result),a=app(request),url=`/api/v1/organizations/${org}/mobile/phone-directory-sync`;
 expect((await a.inject({url,headers})).statusCode).toBe(200);
 expect(request).toHaveBeenCalledWith('user',org,'directory',{});
 expect((await a.inject({url:url+'?cursor=x&number=01012345678',headers})).statusCode).toBe(422);
 expect((await a.inject({url})).statusCode).toBe(401);await a.close();
});
it('rejects cross-organization or invalid directory responses and never marks them fresh',async()=>{
 const a=app(async()=>({...result,organization_id:'00000000-0000-4000-8000-000000000000'}));
 expect((await a.inject({url:`/api/v1/organizations/${org}/mobile/phone-directory-sync`,headers})).statusCode).toBe(503);await a.close();
});
it('limits simultaneous directory requests and releases failed slots',async()=>{
 let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});const fn=vi.fn(async()=>{await hold;throw Error('offline');}),a=app(fn);
 const get=()=>a.inject({url:`/api/v1/organizations/${org}/mobile/phone-directory-sync`,headers});
 const pending=[get(),get()];await vi.waitFor(()=>expect(fn).toHaveBeenCalledTimes(2));expect((await get()).statusCode).toBe(429);release();await Promise.all(pending);await get();expect(fn).toHaveBeenCalledTimes(3);await a.close();
});
