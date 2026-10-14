import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { ApiFailure } from '../errors.js';

const organizationId = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customerId = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const photoId = 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const photo = { id: photoId, organization_id: organizationId, customer_id: customerId, original_name: '시술 전 사진.png', storage_path: 'p', content_type: 'image/png', size_bytes: 100, caption: '', created_at: '2026-10-13T00:00:00Z' };
const trashed = { ...photo, archived_at: '2026-10-14T01:00:00Z', archived_by_name: '원장' };
const base = `/api/v1/organizations/${organizationId}/customers/${customerId}/photos`;
const headers = { authorization: 'Bearer access' };

function build(role: 'owner' | 'member' = 'owner') {
  const writes: boolean[] = [];
  const organizations = {
    requireAccess: async (_token: string, _org: string, feature: string, write = false) => {
      expect(feature).toBe('crm.basic');
      writes.push(write);
      if (write && role === 'member') throw new ApiFailure(403, 'Organization management permission required');
      return role;
    },
  };
  const photos = {
    list: async () => [photo], createUpload: async () => ({}), createDownload: async () => ({}), archive: async () => photo,
    listTrash: async () => [trashed], restore: async (_t: string, _o: string, _c: string, id: string) => (id === photoId ? photo : null),
  };
  return { app: createApp({ organizations: organizations as never, photos: photos as never }), writes };
}

describe('고객 사진 휴지통 라우트 (CRM-15)', () => {
  it('휴지통 목록은 관리자만 읽는다', async () => {
    const { app, writes } = build();
    const result = await app.inject({ url: `${base}/trash`, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual([trashed]);
    expect(writes).toEqual([true]);
    await app.close();
    const member = build('member');
    expect((await member.app.inject({ url: `${base}/trash`, headers })).statusCode).toBe(403);
    await member.app.close();
  });

  it('복원은 사진을 돌려주고, 대상이 없으면 404, 잘못된 ID는 422, 구성원은 403이다', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'POST', url: `${base}/${photoId}/restore`, headers })).json()).toEqual(photo);
    expect((await app.inject({ method: 'POST', url: `${base}/e9cc39fd-8e8c-4df8-a623-1f23a3a936bd/restore`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${base}/not-a-uuid/restore`, headers })).statusCode).toBe(422);
    await app.close();
    const member = build('member');
    expect((await member.app.inject({ method: 'POST', url: `${base}/${photoId}/restore`, headers })).statusCode).toBe(403);
    await member.app.close();
  });

  it('게이트웨이가 휴지통을 지원하지 않으면 503이다', async () => {
    const organizations = { requireAccess: async () => 'owner' };
    const photos = { list: async () => [], createUpload: async () => ({}), createDownload: async () => ({}), archive: async () => null };
    const app = createApp({ organizations: organizations as never, photos: photos as never });
    expect((await app.inject({ url: `${base}/trash`, headers })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: `${base}/${photoId}/restore`, headers })).statusCode).toBe(503);
    await app.close();
  });

  it('기존 삭제·목록 경로는 휴지통 경로와 겹치지 않는다', async () => {
    const { app } = build();
    expect((await app.inject({ url: base, headers })).json()).toEqual([photo]);
    expect((await app.inject({ method: 'DELETE', url: `${base}/${photoId}`, headers })).statusCode).toBe(200);
    await app.close();
  });
});
