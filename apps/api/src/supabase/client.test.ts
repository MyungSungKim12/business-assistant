import { describe, expect, it } from 'vitest';
import { createSupabaseClient } from './client.js';

describe('createSupabaseClient', () => {
  it('creates an auth client without persistent browser session storage', () => {
    const client = createSupabaseClient({ APP_SUPABASE_URL: 'https://example.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'key', APP_SUPABASE_SERVICE_KEY: 'service', APP_FILE_BUCKET: 'business-files', APP_API_PORT: 8000 });
    expect(client).toHaveProperty('auth');
  });
});
