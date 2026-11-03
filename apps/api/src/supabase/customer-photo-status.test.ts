import {afterEach,describe,expect,it,vi} from 'vitest';
import {createCustomerPhotoGateway} from './customer-photos.js';
const org='11111111-1111-4111-8111-111111111111',customer='22222222-2222-4222-8222-222222222222';
const config={APP_SUPABASE_URL:'https://test.invalid',APP_SUPABASE_PUBLISHABLE_KEY:'public',APP_FILE_BUCKET:'business-files',APP_API_PORT:8000};
const row={id:'33333333-3333-4333-8333-333333333333',organization_id:org,customer_id:customer,original_name:'photo.png',upload_state:'failed',created_at:'2026-11-02T00:00:00Z',upload_failure_reason:'object_missing',upload_failed_at:'2026-11-02T03:00:00Z'};
const status={items:[row],limit:250,has_more:false,maintenance:{attempted_at:'2026-11-02T03:00:00Z',finished_at:'2026-11-02T03:00:01Z',state:'succeeded',error_code:null}};
afterEach(()=>vi.unstubAllGlobals());
describe('photo recovery gateway',()=>{
 it('forwards the user JWT and exact org/customer scope to the authorized RPC',async()=>{
  vi.stubGlobal('fetch',async(input:RequestInfo,init?:RequestInit)=>{
   expect(new URL(String(input)).pathname).toBe('/rest/v1/rpc/customer_photo_upload_status');
   expect(new Headers(init?.headers).get('authorization')).toBe('Bearer manager-jwt');
   expect(JSON.parse(String(init?.body))).toEqual({p_organization_id:org,p_customer_id:customer});
   return Response.json(status);
  });
  expect(await createCustomerPhotoGateway(config).uploadStatus!('manager-jwt',org,customer)).toEqual(status);
 });
 it('rejects foreign rows or invalid recovery states rather than exposing them',async()=>{
  for(const invalid of [{...row,organization_id:customer},{...row,customer_id:org},{...row,upload_state:'ready'}]){
   vi.stubGlobal('fetch',async()=>Response.json({...status,items:[invalid]}));
   await expect(createCustomerPhotoGateway(config).uploadStatus!('manager-jwt',org,customer)).rejects.toMatchObject({status:503});
  }
 });
 it('preserves permission denial and exposes outages as retryable failures',async()=>{
  for(const [code,statusCode] of [['42501',403],['42883',503]] as const){
   vi.stubGlobal('fetch',async()=>Response.json({code,message:'private diagnostic'},{status:400}));
   await expect(createCustomerPhotoGateway(config).uploadStatus!('manager-jwt',org,customer)).rejects.toMatchObject({status:statusCode});
  }
 });
});
