import { describe, expect, it } from 'vitest';
import { createSupabaseAuthGateway } from './auth.js';

describe('createSupabaseAuthGateway', () => {
  it('maps Supabase session data to the API session contract', async () => {
    const gateway = createSupabaseAuthGateway({
      auth: { signInWithPassword: async () => ({ data: { session: { access_token: 'access', refresh_token: 'refresh', user: { id: 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd', email: 'owner@example.com', user_metadata: { display_name: '원장' } } } }, error: null }) },
    });
    await expect(gateway.signIn('owner@example.com', 'password')).resolves.toMatchObject({ accessToken: 'access', user: { displayName: '원장' } });
  });
});
