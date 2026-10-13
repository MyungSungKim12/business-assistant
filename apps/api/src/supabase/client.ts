import { createClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../config.js';

export function createSupabaseClient(config: ServerConfig) {
  return createClient(config.APP_SUPABASE_URL, config.APP_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
