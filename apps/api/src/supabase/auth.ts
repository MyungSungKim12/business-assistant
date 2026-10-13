import type { AuthGateway, SessionResult } from '../routes/auth.js';

type SupabaseAuthClient = { auth: { signInWithPassword(input: { email: string; password: string }): Promise<{ data: { session: null | { access_token: string; refresh_token: string; user: { id: string; email?: string; user_metadata?: { display_name?: string } } } }; error: null | unknown }>; } };

export function createSupabaseAuthGateway(client: SupabaseAuthClient): AuthGateway {
  return {
    async signIn(email: string, password: string): Promise<SessionResult> {
      const result = await client.auth.signInWithPassword({ email, password });
      if (result.error || !result.data.session || !result.data.session.user.email) throw new Error('invalid_credentials');
      const { session } = result.data;
      const user = session.user;
      if (!user.email) throw new Error('invalid_credentials');
      return { accessToken: session.access_token, refreshToken: session.refresh_token, user: { userId: user.id, email: user.email, displayName: user.user_metadata?.display_name ?? null } };
    },
  };
}
