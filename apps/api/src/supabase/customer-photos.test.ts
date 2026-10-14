import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config.js';

const calls: Array<{ table: string; patch?: unknown }> = [];
const row = { id: 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd', organization_id: 'b9cc39fd-8e8c-4df8-a623-1f23a3a936bd', customer_id: 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd', original_name: 'face.jpg', storage_path: 'p', content_type: 'image/jpeg', size_bytes: 4, caption: '', created_at: '2026-10-13T00:00:00+00:00' };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd' } }, error: null }) },
    storage: { from: () => ({ createSignedUploadUrl: async () => ({ data: null, error: { message: 'storage down' } }) }) },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const entry: { table: string; patch?: unknown } = { table };
      calls.push(entry);
      chain.insert = () => chain;
      chain.update = (patch: unknown) => { entry.patch = patch; return chain; };
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.single = async () => ({ data: row, error: null });
      chain.then = (resolve: (value: unknown) => void) => resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

describe('customer photo upload preparation', () => {
  it('archives the created record when the signed upload URL cannot be created', async () => {
    const { createCustomerPhotoGateway } = await import('./customer-photos.js');
    const config = { APP_SUPABASE_URL: 'https://x.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'k', APP_FILE_BUCKET: 'b', APP_API_PORT: 1 } as ServerConfig;
    const gateway = createCustomerPhotoGateway(config);
    await expect(gateway.createUpload('token', row.organization_id, row.customer_id, { original_name: 'face.jpg', content_type: 'image/jpeg', size_bytes: 4, caption: '' })).rejects.toMatchObject({ status: 503 });
    expect(calls.some((call) => call.table === 'customer_photos' && JSON.stringify(call.patch) === JSON.stringify({ is_archived: true, archived_reason: "upload_failed" }))).toBe(true);
  });
});
