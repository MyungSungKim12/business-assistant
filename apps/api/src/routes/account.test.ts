import { describe,it,expect,vi } from 'vitest';
import { createApp } from '../app.js';
import {ApiFailure} from '../errors.js';
import {createAuthGuard} from '../security/auth-guard.js';
import {authLimitSettings} from '../config.js';
import {createRuntimeAuth} from '../supabase/runtime-auth.js';
describe('account recovery and sessions',()=>{
 it('makes existing and unknown account responses identical during the same SMTP outage',async()=>{
  const config={APP_SUPABASE_URL:'https://project.example',APP_SUPABASE_PUBLISHABLE_KEY:'public',APP_FILE_BUCKET:'files',APP_API_PORT:8000,APP_AUTH_RECOVERY_URL:'https://api.example/account/recovery'};
  const fetcher=async(_input:RequestInfo|URL,init?:RequestInit)=>{
   const body=JSON.parse(String(init?.body));const existing=body.email==='existing@example.com';
   return new Response(JSON.stringify(existing?{error_code:'unexpected_failure',message:'SMTP unavailable'}:{}),{status:existing?500:200,headers:{'Content-Type':'application/json'}});
  };
  const app=createApp({auth:createRuntimeAuth(config,fetcher)});
  for(const type of ['recovery','signup']){
   const existing=await app.inject({method:'POST',url:'/api/v1/auth/email',payload:{email:'existing@example.com',type}});
   const absent=await app.inject({method:'POST',url:'/api/v1/auth/email',payload:{email:'unknown@example.com',type}});
   expect(existing.statusCode).toBe(absent.statusCode);expect(existing.json()).toEqual(absent.json());expect(existing.json().delivery_confirmed).toBe(false);
  }
  await app.close();
 });
 it('validates recovery input and returns an enumeration-safe response',async()=>{
  const send=vi.fn(async()=>{});const app=createApp({auth:{signIn:vi.fn(),sendAccountEmail:send}});
  expect((await app.inject({method:'POST',url:'/api/v1/auth/email',payload:{email:'a@example.com',type:'recovery',redirect:'https://evil.test'}})).statusCode).toBe(422);
  const result=await app.inject({method:'POST',url:'/api/v1/auth/email',payload:{email:'a@example.com',type:'recovery'}});
  expect(result.statusCode).toBe(200);expect(result.json()).toEqual({message:'입력한 이메일로 진행할 수 있는 경우 안내 메일을 보냅니다.',delivery_confirmed:false});expect(send).toHaveBeenCalledWith('a@example.com','recovery');await app.close();
 });
 it('fails closed when email provider is unavailable',async()=>{const app=createApp({auth:{signIn:vi.fn()}});expect((await app.inject({method:'POST',url:'/api/v1/auth/email',payload:{email:'a@example.com',type:'signup'}})).statusCode).toBe(503);await app.close();});
 it('rejects revoked sessions before business routes',async()=>{const getUser=vi.fn();const app=createApp({auth:{signIn:vi.fn(),getUser,assertSession:async()=>{throw new ApiFailure(401,'Session revoked');}}});expect((await app.inject({url:'/api/v1/me',headers:{authorization:'Bearer old'}})).statusCode).toBe(401);expect(getUser).not.toHaveBeenCalled();await app.close();});
 it('limits email by IP and email before invoking provider',async()=>{const send=vi.fn(async()=>{});const app=createApp({authGuard:createAuthGuard({...authLimitSettings(),signup:{limit:1,windowMs:60000}}),auth:{signIn:vi.fn(),sendAccountEmail:send}});const input={method:'POST' as const,url:'/api/v1/auth/email',payload:{email:'a@example.com',type:'recovery'}};expect((await app.inject(input)).statusCode).toBe(200);expect((await app.inject(input)).statusCode).toBe(429);expect(send).toHaveBeenCalledOnce();await app.close();});
 it('hosts recovery with no-store and restrictive script CSP',async()=>{const app=createApp();const page=await app.inject({url:'/account/recovery'});expect(page.statusCode).toBe(200);expect(page.headers['content-security-policy']).toContain("script-src 'self'");expect(page.headers['cache-control']).toBe('no-store');expect(page.headers['referrer-policy']).toBe('no-referrer');await app.close();});
});
