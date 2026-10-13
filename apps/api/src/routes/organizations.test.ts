import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

describe('organization routes', () => {
  it('rejects an organization list request without an access token', async () => {
    const app = createApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/organizations' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
