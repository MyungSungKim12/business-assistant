import { describe, expect, it } from 'vitest';
import { createCustomerGateway } from './customers.js';
import { createOperationsGateway } from './operations.js';
const org='11111111-1111-4111-8111-111111111111';
const config={APP_SUPABASE_URL:'https://test.invalid',APP_SUPABASE_PUBLISHABLE_KEY:'public',APP_FILE_BUCKET:'files',APP_API_PORT:8000};
const customer=(index:number)=>({id:`22222222-2222-4222-8222-${String(index).padStart(12,'0')}`,organization_id:org,name:'동명 고객',email:null,phone:null,notes:'',birth_date:null,skin_type:null,concerns:[],allergies:'',last_visit_date:null,next_visit_date:null,tags:[],status:'active'});
describe('legacy lists completeness',()=>{
 for(const kind of ['customers','operations'] as const){
  const gateway=(fetcher:typeof fetch)=>kind==='customers'?createCustomerGateway(config,fetcher).list('token',org):createOperationsGateway(config,fetcher).list('token',org,'tasks','created_at.desc');
  it(`${kind}: reads beyond old caps even with a lower database page size`,async()=>{
   const total=5003;let requests=0;
   const result=await gateway(async(input,init)=>{
    const url=new URL(String(input));const start=Number(url.searchParams.get('offset'));
    expect(url.searchParams.get('organization_id')).toBe(`eq.${org}`);
    expect(url.searchParams.get('order')).toMatch(/,id.asc$/);
    expect(new Headers(init?.headers).get('Prefer')).toBe('count=exact');requests++;
    const batch=Array.from({length:Math.min(125,total-start)},(_,i)=>customer(start+i));
    return new Response(JSON.stringify(batch),{headers:{'content-range':`${start}-${start+batch.length-1}/${total}`}});
   });
   expect(result).toHaveLength(total);expect(requests).toBeGreaterThan(1);
  });
  it(`${kind}: rejects incomplete counts and foreign organizations`,async()=>{
   for(const response of [()=>new Response('[]'),()=>new Response(JSON.stringify([{...customer(1),organization_id:'33333333-3333-4333-8333-333333333333'}]),{headers:{'content-range':'0-0/1'}})]){
    await expect(gateway(async()=>response())).rejects.toMatchObject({status:503});
   }
  });
 }
});
