import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config.js';

type Step = { op: string; args: unknown[] };
const queries: Array<{ table: string; steps: Step[] }> = [];
let result: { data: unknown; error: unknown } = { data: [], error: null };
const org = 'b9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customer = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const photoId = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const row = { id: photoId, organization_id: org, customer_id: customer, original_name: 'face.jpg', storage_path: 'p', content_type: 'image/jpeg', size_bytes: 4, caption: '', created_at: '2026-10-13T00:00:00+00:00' };
const trashed = { ...row, archived_at: '2026-10-14T01:00:00Z', archived_by_name: '원장' };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const entry = { table, steps: [] as Step[] };
      queries.push(entry);
      const chain: Record<string, unknown> = {};
      for (const op of ['select', 'update', 'eq', 'order', 'limit']) chain[op] = (...args: unknown[]) => { entry.steps.push({ op, args }); return chain; };
      chain.maybeSingle = async () => result;
      chain.then = (resolve: (value: unknown) => void) => resolve(result);
      return chain;
    },
  }),
}));

const config = { APP_SUPABASE_URL: 'https://x.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'k', APP_FILE_BUCKET: 'b', APP_API_PORT: 1 } as ServerConfig;
const gateway = async () => (await import('./customer-photos.js')).createCustomerPhotoGateway(config);
const eqs = (index = 0) => queries[index].steps.filter((step) => step.op === 'eq').map((step) => step.args.join('='));

beforeEach(() => { queries.length = 0; result = { data: [], error: null }; });

describe('고객 사진 휴지통 게이트웨이 (CRM-15)', () => {
  it('휴지통은 이 고객의 사용자가 삭제한 사진만 최근 삭제순으로 읽는다', async () => {
    result = { data: [trashed], error: null };
    const items = await (await gateway()).listTrash!('t', org, customer);
    expect(items).toEqual([trashed]);
    expect(eqs()).toEqual([`organization_id=${org}`, `customer_id=${customer}`, 'is_archived=true', 'archived_reason=deleted']);
    expect(queries[0].steps.find((step) => step.op === 'select')!.args[0]).toContain('archived_by_name');
    expect(queries[0].steps.find((step) => step.op === 'order')!.args[0]).toBe('archived_at');
  });

  it('응답 형식이 틀리거나 DB 오류면 서버 오류(503)다', async () => {
    result = { data: [{ ...trashed, id: 'bad' }], error: null };
    await expect((await gateway()).listTrash!('t', org, customer)).rejects.toMatchObject({ status: 503 });
    result = { data: null, error: { message: 'down' } };
    await expect((await gateway()).listTrash!('t', org, customer)).rejects.toMatchObject({ status: 503 });
  });

  it('복원은 삭제된 사진만 is_archived=false로 되돌리고 삭제 기록은 DB가 지운다', async () => {
    result = { data: row, error: null };
    const restored = await (await gateway()).restore!('t', org, customer, photoId);
    expect(restored).toEqual(row);
    expect(queries[0].steps.find((step) => step.op === 'update')!.args[0]).toEqual({ is_archived: false });
    expect(eqs()).toEqual([`id=${photoId}`, `organization_id=${org}`, `customer_id=${customer}`, 'is_archived=true', 'archived_reason=deleted']);
  });

  it('복원할 대상이 없으면 null(라우트가 404)이고 오류는 503이다', async () => {
    result = { data: null, error: null };
    expect(await (await gateway()).restore!('t', org, customer, photoId)).toBeNull();
    result = { data: null, error: { message: 'down' } };
    await expect((await gateway()).restore!('t', org, customer, photoId)).rejects.toMatchObject({ status: 503 });
  });

  it('삭제는 사유 deleted를 함께 보낸다', async () => {
    result = { data: row, error: null };
    await (await gateway()).archive('t', org, customer, photoId);
    expect(queries[0].steps.find((step) => step.op === 'update')!.args[0]).toEqual({ is_archived: true, archived_reason: 'deleted' });
  });
});
