import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { ApiFailure } from '../errors.js';

const organizationId = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const customerId = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const photoId = 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const photo = { id: photoId, organization_id: organizationId, customer_id: customerId, original_name: '시술 전 사진.png', storage_path: `${organizationId}/${customerId}/${photoId}-photo.png`, content_type: 'image/png', size_bytes: 100, caption: '', created_at: '2026-10-13T00:00:00Z' };

function fixture() {
  const writes: boolean[] = [];
  const organizations = { requireAccess: async (_token: string, _organizationId: string, feature: string, write = false) => { expect(feature).toBe('crm.basic'); writes.push(write); return 'owner'; } };
  const photos = {
    list: async () => [photo],
    completeUpload: async (_t:string,o:string,c:string,id:string) => { expect([o,c,id]).toEqual([organizationId,customerId,photoId]);return photo; },
    createUpload: async (_token: string, _organizationId: string, _customerId: string, input: { original_name: string }) => ({ photo: { ...photo, original_name: input.original_name }, signed_url: 'https://example.supabase.co/storage/v1/object/upload/sign/business-files/safe.png?token=x', expires_in: 600 }),
    createDownload: async () => ({ photo, signed_url: 'https://example.supabase.co/storage/v1/object/sign/business-files/safe.png?token=x', expires_in: 300 }),
    archive: async (_token: string, _organizationId: string, _customerId: string, id: string) => id === photoId ? photo : null,
  };
  return { app: createApp({ organizations: organizations as never, photos }), writes };
}

describe('customer photo HTTP flow', () => {
  it('returns manager-only pending/failed recovery status and denies org/role/anonymous access',async()=>{
    const status={items:[],limit:250,has_more:false,maintenance:null};
    const app=createApp({organizations:{requireAccess:async(token:string,id:string,feature:string,write?:boolean)=>{
      expect(feature).toBe('crm.basic');expect(write).toBe(true);
      if(token!=='manager'||id!==organizationId)throw new ApiFailure(403,'Access denied');return 'admin';
    }} as never,photos:{uploadStatus:async()=>status} as never});
    const url=`/api/v1/organizations/${organizationId}/customers/${customerId}/photos/upload-status`;
    expect((await app.inject({url})).statusCode).toBe(401);
    expect((await app.inject({url,headers:{authorization:'Bearer member'}})).statusCode).toBe(403);
    expect((await app.inject({url:url.replace(organizationId,photoId),headers:{authorization:'Bearer manager'}})).statusCode).toBe(403);
    const result=await app.inject({url,headers:{authorization:'Bearer manager'}});expect(result.statusCode).toBe(200);expect(result.json()).toEqual(status);
    await app.close();
  });
  it('requires manager access and valid scoped IDs before confirming an upload',async()=>{
    const {app,writes}=fixture();const url=`/api/v1/organizations/${organizationId}/customers/${customerId}/photos/${photoId}/complete`;
    expect((await app.inject({method:'POST',url})).statusCode).toBe(401);
    const result=await app.inject({method:'POST',url,headers:{authorization:'Bearer access'}});
    expect(result.statusCode).toBe(200);expect(result.json()).toEqual(photo);expect(writes).toEqual([true]);
    expect((await app.inject({method:'POST',url:url.replace(photoId,'bad'),headers:{authorization:'Bearer access'}})).statusCode).toBe(422);
    await app.close();
  });
  it('lists only photos scoped to the selected customer', async () => {
    const { app, writes } = fixture();
    const result = await app.inject({ url: `/api/v1/organizations/${organizationId}/customers/${customerId}/photos`, headers: { authorization: 'Bearer access' } });
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual([photo]); expect(writes).toEqual([false]); await app.close();
  });
  it('creates an upload URL for a valid image while preserving its display name', async () => {
    const { app, writes } = fixture();
    const result = await app.inject({ method: 'POST', url: `/api/v1/organizations/${organizationId}/customers/${customerId}/photos/upload-url`, headers: { authorization: 'Bearer access' }, payload: { original_name: '시술 전 사진.png', content_type: 'image/png', size_bytes: 100, caption: '' } });
    expect(result.statusCode).toBe(201); expect(result.json().photo.original_name).toBe('시술 전 사진.png'); expect(result.json().signed_url).toContain('/storage/'); expect(writes).toEqual([true]); await app.close();
  });
  it('rejects executable files before preparing storage metadata', async () => {
    const { app } = fixture();
    const result = await app.inject({ method: 'POST', url: `/api/v1/organizations/${organizationId}/customers/${customerId}/photos/upload-url`, headers: { authorization: 'Bearer access' }, payload: { original_name: 'bad.exe', content_type: 'application/octet-stream', size_bytes: 100, caption: '' } });
    expect(result.statusCode).toBe(422); await app.close();
  });
});
