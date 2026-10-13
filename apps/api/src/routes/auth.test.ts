import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

describe('authentication routes', () => {
  it('returns a session when the credentials are accepted', async () => {
    const app = createApp({
      auth: {
        signIn: async () => ({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          user: { userId: 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd', email: 'owner@example.com', displayName: '원장' },
        }),
      },
    });

    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'owner@example.com', password: 'correct-password' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ access_token: 'access-token', refresh_token: 'refresh-token', user: { email: 'owner@example.com' } });
    await app.close();
  });
});
