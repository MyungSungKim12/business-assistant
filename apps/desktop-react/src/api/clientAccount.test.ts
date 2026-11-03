import {describe,it,expect,vi} from 'vitest';
import {ApiClient} from './client';
import type {Platform} from '../platform/types';
const session={access_token:'access',refresh_token:'refresh',user:{user_id:'11111111-1111-4111-8111-111111111111',email:'a@example.com',display_name:null}};
describe('account client logout',()=>{
 it('does not confirm server logout when expired JWT is rejected with 401',async()=>{
  let saved:string|null=null;
  const platform={tokenStore:{load:async()=>saved,save:async(value:string)=>{saved=value;},clear:async()=>{saved=null;}},request:async(request:{path:string})=>({status:request.path==='/auth/login'?200:401,headers:{},body:JSON.stringify(request.path==='/auth/login'?session:{detail:'JWT expired'})})} as unknown as Platform;
  const api=new ApiClient(platform);await api.login('a@example.com','password');await expect(api.logout()).rejects.toMatchObject({status:401});expect(saved).toBeNull();await expect(api.listOrganizations()).rejects.toMatchObject({status:401});
 });
 it('clears local keyring before server logout failure and sends captured bearer',async()=>{
  let saved:string|null=null;const seen:string[]=[];
  const platform={tokenStore:{load:async()=>saved,save:async(value:string)=>{saved=value;},clear:async()=>{saved=null;}},request:vi.fn(async(request)=>{
   if(request.path==='/auth/login')return {status:200,headers:{},body:JSON.stringify(session)};
   expect(saved).toBeNull();seen.push(request.headers.Authorization);return {status:503,headers:{},body:'{}'};
  })} as unknown as Platform;
  const api=new ApiClient(platform);await api.login('a@example.com','password');await expect(api.logout()).rejects.toMatchObject({status:503});expect(saved).toBeNull();expect(seen).toEqual(['Bearer access']);await expect(api.listOrganizations()).rejects.toMatchObject({status:401});
 });
 it('clears current revoked session and does not send a second server logout',async()=>{
  let saved:string|null=null;const paths:string[]=[];const platform={tokenStore:{load:async()=>saved,save:async(value:string)=>{saved=value;},clear:async()=>{saved=null;}},request:async(request:{path:string})=>{paths.push(request.path);return {status:200,headers:{},body:JSON.stringify(request.path==='/auth/login'?session:{current_revoked:true})};}} as unknown as Platform;
  const api=new ApiClient(platform);await api.login('a@example.com','password');await api.revokeAccountSessions(null);await api.logout();expect(saved).toBeNull();expect(paths).toEqual(['/auth/login','/auth/sessions/revoke']);
 });
});
