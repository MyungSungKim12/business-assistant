import { describe, expect, it } from 'vitest';
import { build, customerId, headers, json, operationId, organizationId, otherOrganizationId, treatmentId } from './fixtures.js';

const base = `/api/v1/organizations/${organizationId}/customers/${customerId}/treatment-photos`;
const photo = {
  id: operationId, organization_id: organizationId, customer_id: customerId, treatment_id: treatmentId, storage_path: `${organizationId}/p-a.jpg`,
  thumbnail_path: null, phase: 'before', content_type: 'image/jpeg', caption: '', sort_order: 0, taken_at: null,
};
const create = (payload: Record<string, unknown>) => ({ method: 'POST' as const, url: base, headers, payload });

describe('시술 사진 전/후 구분(phase)', () => {
  it('목록 응답에 phase 를 싣고 조회 열에도 요청한다', async () => {
    const { app, calls } = build({ role: 'member', provider: () => json([photo, { ...photo, id: treatmentId, phase: null }]) });
    const result = await app.inject({ url: `${base}?treatment_id=${treatmentId}`, headers });
    expect(result.json().map((row: { phase: string | null }) => row.phase)).toEqual(['before', null]);
    expect(calls[0].url.searchParams.get('select')).toContain('phase');
  });

  it('연결 시 phase 를 그대로 전달하고, 생략하면 본문에 넣지 않는다', async () => {
    const { app, calls } = build({ provider: () => json([photo]) });
    const result = await app.inject(create({ treatment_id: treatmentId, storage_path: photo.storage_path, phase: 'after', caption: '시술 후' }));
    expect(result.statusCode).toBe(201);
    expect(calls[0].body).toMatchObject({ phase: 'after', caption: '시술 후', treatment_id: treatmentId });
    await app.inject(create({ treatment_id: treatmentId, storage_path: photo.storage_path }));
    expect(calls[1].body).not.toHaveProperty('phase');
  });

  it.each(['pre', 'BEFORE', 1, true])('허용되지 않은 phase %j 는 422 이고 DB 를 부르지 않는다', async (phase) => {
    const { app, calls } = build();
    expect((await app.inject(create({ treatment_id: treatmentId, storage_path: photo.storage_path, phase }))).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('다른 조직의 저장 경로는 연결할 수 없다(멤버는 먼저 403)', async () => {
    const foreign = { treatment_id: treatmentId, storage_path: `${otherOrganizationId}/p-a.jpg` };
    const owner = build();
    expect((await owner.app.inject(create(foreign))).statusCode).toBe(422);
    expect(owner.calls).toEqual([]);
    expect((await build({ role: 'member' }).app.inject(create(foreign))).statusCode).toBe(403);
  });

  it('PATCH 는 phase·caption 만 바꾸고 owner/admin 만 가능하다', async () => {
    const { app, calls, access } = build({ provider: () => json([{ ...photo, phase: 'after' }]) });
    const result = await app.inject({ method: 'PATCH', url: `${base}/${photo.id}`, headers, payload: { phase: 'after' } });
    expect(result.statusCode).toBe(200);
    expect(result.json().phase).toBe('after');
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body).toEqual({ phase: 'after' });
    expect(calls[0].url.searchParams.get('id')).toBe(`eq.${photo.id}`);
    expect(calls[0].url.searchParams.get('organization_id')).toBe(`eq.${organizationId}`);
    expect(calls[0].url.searchParams.get('customer_id')).toBe(`eq.${customerId}`);
    expect(access).toEqual([{ feature: 'crm.basic', write: true }]);
    expect((await build({ role: 'member' }).app.inject({ method: 'PATCH', url: `${base}/${photo.id}`, headers, payload: { phase: 'after' } })).statusCode).toBe(403);
  });

  it('PATCH 로 phase 를 null(미분류)로 되돌릴 수 있다', async () => {
    const { app, calls } = build({ provider: () => json([{ ...photo, phase: null }]) });
    expect((await app.inject({ method: 'PATCH', url: `${base}/${photo.id}`, headers, payload: { phase: null } })).statusCode).toBe(200);
    expect(calls[0].body).toEqual({ phase: null });
  });

  it.each([{}, { phase: 'x' }, { storage_path: 'other' }, { treatment_id: treatmentId }, { caption: 'x'.repeat(501) }])('잘못된 PATCH 본문 %j 는 422', async (payload) => {
    const { app, calls } = build();
    expect((await app.inject({ method: 'PATCH', url: `${base}/${photo.id}`, headers, payload })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('PATCH 대상이 없으면 404, 사진 ID 가 잘못되면 422', async () => {
    const missing = await build({ provider: () => json([]) }).app.inject({ method: 'PATCH', url: `${base}/${photo.id}`, headers, payload: { phase: 'after' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().detail).toBe('Treatment photo not found');
    expect((await build().app.inject({ method: 'PATCH', url: `${base}/not-a-uuid`, headers, payload: { phase: 'after' } })).statusCode).toBe(422);
  });

  it('PATCH 응답이 다른 조직 행이면 안전한 503', async () => {
    const { app } = build({ provider: () => json([{ ...photo, organization_id: otherOrganizationId }]) });
    expect((await app.inject({ method: 'PATCH', url: `${base}/${photo.id}`, headers, payload: { phase: 'after' } })).statusCode).toBe(503);
  });
});
