import {describe,it,expect} from 'vitest';
import {createApp} from '../../../api/src/app';
import {createRuntimeAuth} from '../../../api/src/supabase/runtime-auth';
import {ApiClient} from './client';
import type {Platform} from '../platform/types';
const user={id:'11111111-1111-4111-8111-111111111111',email:'a@example.com',user_metadata:{}};
const config={APP_SUPABASE_URL:'https://project.example',APP_SUPABASE_PUBLISHABLE_KEY:'public-key',APP_FILE_BUCKET:'files',APP_API_PORT:8000};
describe('desktop refresh through global live-session API hook',()=>{
 it('refreshes an expired access JWT and retries protected request once',async()=>{
  let refreshes=0;const provider=async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=String(input),headers=new Headers(init?.headers);
   const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
   if(url.includes('assert_current_session'))return headers.get('Authorization')==='Bearer expired'?json({code:'PGRST301',message:'JWT expired'},401):json(true);
   if(url.includes('/auth/v1/token')){
    const refreshing=url.includes('refresh_token');if(refreshing)refreshes++;
    return json({access_token:refreshing?'fresh':'expired',refresh_token:'refresh-token',expires_in:3600,token_type:'bearer',user});
   }
   if(url.endsWith('/auth/v1/user'))return json(user);
   throw new Error('Unexpected mock URL');
  };
  const app=createApp({auth:createRuntimeAuth(config,provider)});
  let saved:string|null=null;
  const platform={tokenStore:{load:async()=>saved,save:async(value:string)=>{saved=value;},clear:async()=>{saved=null;}},request:async(request:{method:string;path:string;headers:Record<string,string>;body?:string})=>{
   const response=await app.inject({method:request.method as 'GET',url:'/api/v1'+request.path,headers:request.headers,...(request.body?{payload:request.body}:{})});return {status:response.statusCode,headers:{},body:response.body};
  }} as unknown as Platform;
  const client=new ApiClient(platform);await client.login('a@example.com','password');
  const {z}=await import('zod');await expect(client.call('GET','/me',z.object({user_id:z.string()}))).resolves.toEqual({user_id:user.id});expect(refreshes).toBe(1);await app.close();
 });
});

