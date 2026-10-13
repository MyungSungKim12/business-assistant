import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { AuthGateway, SessionResult } from '../routes/auth.js';
import { ApiFailure } from '../errors.js';

// Each operation owns a client: session state from one login cannot leak into another request.
export function createRuntimeAuth(config:ServerConfig):AuthGateway {
  const client = () => createClient(config.APP_SUPABASE_URL,config.APP_SUPABASE_PUBLISHABLE_KEY,{
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
    async signIn(email,password) {
      const result = await client().auth.signInWithPassword({email,password});
      check(result.error); return session(result.data.session);
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

