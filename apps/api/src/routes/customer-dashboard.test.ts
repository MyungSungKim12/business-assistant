import { expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createCustomerGateway } from '../supabase/customers.js';
import { ApiFailure } from '../errors.js';
const org='11111111-1111-4111-8111-111111111111';
const summary={organization_id:org,active_count:1501,upcoming_count:301,recent:[],upcoming:[]};
it('returns server totals beyond a search page using scoped RPC and feature access',async()=>{
 const calls:unknown[]=[];
 const gateway=createCustomerGateway({APP_SUPABASE_URL:'https://test.invalid',APP_SUPABASE_PUBLISHABLE_KEY:'test',APP_FILE_BUCKET:'business-files',APP_API_PORT:8000},async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify(summary));});
 const app=createApp({customers:gateway,organizations:{requireAccess:async(_t:string,o:string,f:string)=>{expect([o,f]).toEqual([org,'crm.basic']);return 'member';}} as never});
 try{const r=await app.inject({method:'GET',url:`/api/v1/organizations/${org}/customer-dashboard?today=2026-10-30`,headers:{authorization:'Bearer test'}});expect(r.statusCode).toBe(200);expect(r.json()).toEqual(summary);expect(calls).toEqual([{p_organization_id:org,p_today:'2026-10-30'}]);}finally{await app.close();}
});
it('rejects unauthorized, invalid and foreign dashboard queries',async()=>{
 const app=createApp({customers:{dashboard:async()=>summary},organizations:{requireAccess:async()=>{throw new ApiFailure(403,'Access denied');}}} as never);
 try{const url=`/api/v1/organizations/${org}/customer-dashboard`;expect((await app.inject({method:'GET',url})).statusCode).toBe(401);expect((await app.inject({method:'GET',url:url+'?today=bad',headers:{authorization:'Bearer test'}})).statusCode).toBe(422);expect((await app.inject({method:'GET',url:url+'?today=2026-10-30',headers:{authorization:'Bearer test'}})).statusCode).toBe(403);}finally{await app.close();}
 const gateway=createCustomerGateway({APP_SUPABASE_URL:'https://test.invalid',APP_SUPABASE_PUBLISHABLE_KEY:'test',APP_FILE_BUCKET:'business-files',APP_API_PORT:8000},async()=>new Response(JSON.stringify({...summary,organization_id:'22222222-2222-4222-8222-222222222222'})));
 await expect(gateway.dashboard('test',org,'2026-10-30')).rejects.toMatchObject({status:503});
});
