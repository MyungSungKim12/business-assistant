import {describe,it,expect,vi} from 'vitest';
import {createRuntimeAuth} from './runtime-auth.js';
const config={APP_SUPABASE_URL:'https://project.example',APP_SUPABASE_PUBLISHABLE_KEY:'public-key',APP_FILE_BUCKET:'files',APP_API_PORT:8000,APP_AUTH_RECOVERY_URL:'https://api.example/account/recovery'};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
describe('runtime account adapter (no network)',()=>{
 it('preserves provider expired JWT 401 so clients can refresh',async()=>{
  for(const code of ['PGRST301','PGRST303'])await expect(createRuntimeAuth(config,vi.fn(async()=>response({code,message:'JWT expired'},401))).assertSession!('expired')).rejects.toMatchObject({status:401});
  await expect(createRuntimeAuth(config,vi.fn(async()=>response({code:'08006',message:'unavailable'},503))).assertSession!('valid')).rejects.toMatchObject({status:503});
 });
 it('reports committed password change when session cleanup fails',async()=>{
  for(const status of [401,503]){
   const fetcher=vi.fn(async(input:RequestInfo|URL)=>String(input).includes('revoke_account_sessions')?response({code:status===401?'PGRST303':'08006'},status):response(true));
   await expect(createRuntimeAuth(config,fetcher).resetPassword!('recovery','new-password')).resolves.toEqual({password_changed:true,session_cleanup_pending:true});
  }
 });
 it('distinguishes rejected passwords and uncertain network outcomes from expired links',async()=>{
  for(const code of ['same_password','weak_password']){
   const fetcher=vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith('/user')?response({code},422):response(true));
   await expect(createRuntimeAuth(config,fetcher).resetPassword!('recovery','new-password')).rejects.toMatchObject({status:422,extra:{code:'password_validation'}});expect(fetcher).toHaveBeenCalledTimes(2);
  }
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{if(String(input).endsWith('/user')){expect(init?.redirect).toBe('error');expect(init?.signal).toBeDefined();throw new Error('lost reply');}return response(true);});
  await expect(createRuntimeAuth(config,fetcher).resetPassword!('recovery','new-password')).rejects.toMatchObject({status:503,extra:{code:'password_update_unknown'}});
 });
 it('uses fixed configured recovery and confirmation redirect',async()=>{
  const fetcher=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>response({}));const auth=createRuntimeAuth(config,fetcher);
  await auth.sendAccountEmail!('owner@example.com','recovery');await auth.sendAccountEmail!('owner@example.com','signup');
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('redirect_to=https%3A%2F%2Fapi.example%2Faccount%2Frecovery');
  expect(String(fetcher.mock.calls[1]?.[0])).toContain('/auth/v1/resend');
 });
 it('fails closed for missing, credentials, query, path, and non-loopback http redirects',async()=>{
  for(const value of [undefined,'https://u:p@api.example/account/recovery','https://api.example/account/recovery?token=x','https://api.example/other','http://api.example/account/recovery']){
   const fetcher=vi.fn();await expect(createRuntimeAuth({...config,APP_AUTH_RECOVERY_URL:value},fetcher).sendAccountEmail!('a@example.com','recovery')).rejects.toMatchObject({status:503});expect(fetcher).not.toHaveBeenCalled();
  }
  const fetcher=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>response({}));await createRuntimeAuth({...config,APP_AUTH_RECOVERY_URL:'http://127.0.0.1:8000/account/recovery',APP_AUTH_ALLOW_LOOPBACK_RECOVERY:true},fetcher).sendAccountEmail!('a@example.com','recovery');expect(fetcher).toHaveBeenCalledOnce();
 });
 it('hides unknown account errors but surfaces operational failure',async()=>{
  for(const error_code of ['user_not_found','email_already_confirmed','over_email_send_rate_limit']){
   const unknown=createRuntimeAuth(config,vi.fn(async()=>response({error_code,msg:'account state'},400)));
   await expect(unknown.sendAccountEmail!('a@example.com','recovery')).resolves.toBeUndefined();
  }
  const outage=createRuntimeAuth(config,vi.fn(async()=>response({message:'smtp failure'},500)));
  await expect(outage.sendAccountEmail!('a@example.com','recovery')).rejects.toMatchObject({status:503});
 });
 it('checks live session before password update, never forwarding provider secrets',async()=>{
  const fetcher=vi.fn(async(input:RequestInfo|URL)=>String(input).includes('assert_current_session')?response({code:'42501',message:'session missing'},403):response({}));
  await expect(createRuntimeAuth(config,fetcher).resetPassword!('old-jwt','new-password')).rejects.toMatchObject({status:401});expect(fetcher).toHaveBeenCalledOnce();
 });
 it('updates password with bearer and revokes refresh-capable sessions',async()=>{
  const fetcher=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>response(true));await createRuntimeAuth(config,fetcher).resetPassword!('recovery-jwt','new-password');
  expect(fetcher.mock.calls.map(call=>String(call[0]))).toEqual(['https://project.example/rest/v1/rpc/assert_current_session','https://project.example/auth/v1/user','https://project.example/rest/v1/rpc/revoke_account_sessions']);
 });
});

