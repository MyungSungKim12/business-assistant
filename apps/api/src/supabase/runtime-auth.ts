import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { AuthGateway, SessionResult } from '../routes/auth.js';
import { ApiFailure } from '../errors.js';

// Each operation owns a client: session state from one login cannot leak into another request.
export function createRuntimeAuth(config:ServerConfig,fetcher:typeof fetch=fetch):AuthGateway {
  const rpc=async(token:string,name:string,args:Record<string,unknown>={})=>{
    const result=await createClient(config.APP_SUPABASE_URL,config.APP_SUPABASE_PUBLISHABLE_KEY,{global:{fetch:fetcher,headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}}).rpc(name,args);
    if(result.error)throw new ApiFailure(result.status===401||['28000','PGRST301','PGRST303'].includes(result.error.code)||(name==='assert_current_session'&&result.error.code==='42501')?401:result.error.code==='42501'?403:503,'Session unavailable');return result.data;
  };
  const redirect=()=>{
    const value=config.APP_AUTH_RECOVERY_URL;if(!value)throw new ApiFailure(503,'Recovery URL not configured');
    const url=new URL(value);
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/account/recovery'||(url.protocol!=='https:'&&!(config.APP_AUTH_ALLOW_LOOPBACK_RECOVERY&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new ApiFailure(503,'Invalid recovery configuration');
    return url.href;
  };
  const assertSession=async(token:string)=>{if(await rpc(token,'assert_current_session')!==true)throw new ApiFailure(503,'Session verification unavailable');};
  const client = () => createClient(config.APP_SUPABASE_URL,config.APP_SUPABASE_PUBLISHABLE_KEY,{
    global:{fetch:fetcher},
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  });
  const userSchema = z.object({id:z.uuid(),email:z.string().min(1),user_metadata:z.record(z.string(),z.unknown()).optional()});
  function user(value:unknown):SessionResult['user'] {
    const parsed = userSchema.safeParse(value);
    if (!parsed.success) throw new ApiFailure(503,'Authentication unavailable');
    const u = parsed.data;
    return {userId:u.id,email:u.email,displayName:typeof u.user_metadata?.display_name === 'string' ? u.user_metadata.display_name:null};
  }
  function check(error:unknown) {
    if (!error) return;
    const status = typeof error === 'object' && 'status' in error ? Number(error.status):0;
    throw new ApiFailure(status >= 400 && status < 500 && status !== 429 ? 401:503,
      status >= 400 && status < 500 && status !== 429 ? 'Invalid credentials':'Authentication unavailable');
  }
  function session(value:unknown):SessionResult {
    const parsed = z.object({access_token:z.string().min(1),refresh_token:z.string().nullable(),user:z.unknown()}).safeParse(value);
    if (!parsed.success) throw new ApiFailure(503,'Authentication unavailable');
    return {accessToken:parsed.data.access_token,refreshToken:parsed.data.refresh_token,user:user(parsed.data.user)};
  }
  return {
    async logout(token){
      await assertSession(token);
      let id:unknown;try{id=JSON.parse(Buffer.from(token.split('.')[1]??'','base64url').toString()).session_id;}catch{throw new ApiFailure(401,'Invalid session');}
      if(!z.uuid().safeParse(id).success)throw new ApiFailure(401,'Invalid session');
      await rpc(token,'revoke_account_sessions',{p_session_id:id});
    },
    assertSession,
    async listSessions(token,cursor){return rpc(token,'list_account_sessions',{p_cursor:cursor??null,p_limit:50});},
    async revokeSessions(token,sessionId){return rpc(token,'revoke_account_sessions',{p_session_id:sessionId});},
    async sendAccountEmail(email,type){
      const emailRedirectTo=redirect();
      const result=type==='recovery'?await client().auth.resetPasswordForEmail(email,{redirectTo:emailRedirectTo}):await client().auth.resend({type:'signup',email,options:{emailRedirectTo}});
      if(result.error){
        // Provider account-state responses are indistinguishable. Operational failures remain visible.
        if(['user_not_found','email_not_confirmed','email_already_confirmed','email_exists','user_already_exists','over_email_send_rate_limit'].includes(result.error.code??''))return;
        throw new ApiFailure(503,'Email delivery unavailable',{code:'email_provider_failure'});
      }
    },
    async resetPassword(token,password){
      await assertSession(token);
      let result:Response;
      try{result=await fetcher(`${config.APP_SUPABASE_URL}/auth/v1/user`,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{apikey:config.APP_SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({password})});}
      catch{throw new ApiFailure(503,'Password update outcome unknown',{code:'password_update_unknown'});}
      if(!result.ok){
        const details=await result.json().catch(()=>null) as {code?:string;error_code?:string}|null;
        if(['same_password','weak_password','validation_failed'].includes(details?.code??details?.error_code??''))throw new ApiFailure(422,'Choose a different valid password',{code:'password_validation'});
        if(result.status===401||result.status===403)throw new ApiFailure(401,'Recovery link expired');
        if(result.status===422||result.status===400)throw new ApiFailure(422,'Choose a different valid password',{code:'password_validation'});
        throw new ApiFailure(503,'Password update outcome unknown',{code:'password_update_unknown'});
      }
      // Password changes may invalidate the recovery session at the provider itself.
      try{await rpc(token,'revoke_account_sessions',{p_session_id:null});return {password_changed:true,session_cleanup_pending:false};}
      catch{return {password_changed:true,session_cleanup_pending:true};}
    },
    async signIn(email,password) {
      const result = await client().auth.signInWithPassword({email,password});
      check(result.error); return session(result.data.session);
    },
    async signUp(email,password,displayName) {
      const result = await client().auth.signUp({email,password,options:{data:{display_name:displayName}}});
      check(result.error);
      if (!result.data.session) {
        if (!result.data.user) throw new ApiFailure(503,'Authentication unavailable');
        return null;
      }
      return session(result.data.session);
    },
    async refresh(refresh_token) {
      const result = await client().auth.refreshSession({refresh_token});
      check(result.error); return session(result.data.session);
    },
    async getUser(token) {
      const result = await client().auth.getUser(token);
      check(result.error); return user(result.data.user);
    },
  };
}

