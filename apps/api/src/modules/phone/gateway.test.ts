import {it,expect,vi} from 'vitest';
import {createPhoneGateway} from './gateway.js';
const org='a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const config={APP_SUPABASE_URL:'https://db.example',APP_SUPABASE_PUBLISHABLE_KEY:'public-key'} as never;
it('uses only the callers bearer and checks every returned organization',async()=>{
 const fetcher=vi.fn(async()=>Response.json({enabled:false,version:0,retention_days:30}));const gateway=createPhoneGateway(config,fetcher);
 await expect(gateway.request('caller-token',org,'consent',{})).resolves.toMatchObject({enabled:false});
 expect(fetcher).toHaveBeenCalledWith(expect.any(URL),expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer caller-token',apikey:'public-key'}),body:JSON.stringify({p_org:org,p_action:'consent',p_input:{}})}));
 const broken=createPhoneGateway(config,async()=>Response.json({items:[{id:org,organization_id:org,recipient_id:org,phone_e164:'+821012345678',occurred_at:'now',received_at:'now',expires_at:'now',customer_ids:[org],retained:true,retained_until:'now',status:'seen',assignee_id:null,version:1,callback_task_id:null}],cursor:'x',next_cursor:null}));
 await expect(broken.request('token','b9cc39fd-8e8c-4df8-a623-1f23a3a936bd','list',{})).rejects.toMatchObject({status:503});
});
it.each([['40001',400,409],['23505',409,409],['P0002',400,404],['22023',400,422],['42501',403,403]])('maps SQL %s to the expected business response',async(code,http,status)=>{
 const gateway=createPhoneGateway(config,async()=>Response.json({code},{status:http as number}));
 await expect(gateway.request('token',org,'poll',{})).rejects.toMatchObject({status:status});
});
it('rejects malformed DB payloads and network failures instead of presenting success',async()=>{
 for(const fetcher of [async()=>Response.json({enabled:true}),async()=>{throw new Error('offline');}])await expect(createPhoneGateway(config,fetcher).request('token',org,'consent',{})).rejects.toMatchObject({status:503});
});
it('maps the directory action to its JWT-only RPC and validates its result',async()=>{
 const data={organization_id:org,mode:'delta',items:[],revision:'2',next_cursor:null,cursor:'checkpoint',reset_required:false};
 const fetcher=vi.fn(async()=>Response.json(data));await expect(createPhoneGateway(config,fetcher).request('jwt',org,'directory',{cursor:'old'})).resolves.toMatchObject({revision:'2'});
 expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({pathname:'/rest/v1/rpc/phone_directory'}),expect.objectContaining({body:JSON.stringify({p_org:org,p_cursor:'old',p_limit:200}),headers:expect.objectContaining({Authorization:'Bearer jwt'})}));
 for(const broken of [{...data,organization_id:'00000000-0000-4000-8000-000000000000'},{...data,cursor:null},{...data,reset_required:true,cursor:'wrong'}])await expect(createPhoneGateway(config,async()=>Response.json(broken)).request('jwt',org,'directory',{})).rejects.toMatchObject({status:503});
});
