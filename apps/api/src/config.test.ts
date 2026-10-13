import { describe, expect, it } from 'vitest';
import { parseServerConfig } from './config.js';

describe('parseServerConfig', () => {
  it('rejects an incomplete Supabase server configuration', () => {
    expect(() => parseServerConfig({ APP_SUPABASE_PUBLISHABLE_KEY: 'key' }))
      .toThrow(/APP_SUPABASE_URL/);
  });
});
