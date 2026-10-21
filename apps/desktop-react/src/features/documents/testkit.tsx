import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { vi } from 'vitest';
import type { z } from 'zod';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { FileStorageUsage } from './schemas';

export const ORG = '22222222-2222-4222-8222-222222222222';
export const CUSTOMER = '11111111-1111-4111-8111-111111111111';
export const TREATMENT = '33333333-3333-4333-8333-333333333333';
export const TEMPLATE = '44444444-4444-4444-8444-444444444444';
export const DOCUMENT = '55555555-5555-4555-8555-555555555555';
export const USER = '66666666-6666-4666-8666-666666666666';
export const FILE = '77777777-7777-4777-8777-777777777777';
const stamp = '2026-10-13T00:00:00Z';

export const template = { id: TEMPLATE, organization_id: ORG, created_by: USER, name: '시술 동의서', description: '', content: '안녕하세요 {{customer.name}}', is_archived: false, created_at: stamp, updated_at: stamp, status: 'draft', version: 1, revision: 1 };
export const published = { ...template, status: 'published', version: 2, revision: 3 };
export const document = { id: DOCUMENT, organization_id: ORG, template_id: null, created_by: USER, title: '안내문', content: '본문', status: 'draft', created_at: stamp, updated_at: stamp };
export const issued = { id: DOCUMENT, organization_id: ORG, customer_id: CUSTOMER, treatment_id: TREATMENT, template_id: TEMPLATE, template_version: 2, title: '시술 동의서', content: '안녕하세요 김고객', source_snapshot: { customer: { name: '김고객', phone: '010' }, treatment: { name: '필러', date: '2026-10-13' } }, issued_by: USER, issued_at: stamp };
export const preview = { template_id: TEMPLATE, template_version: 2, title: '시술 동의서', content: '안녕하세요 김고객', source_snapshot: issued.source_snapshot, missing_fields: [] as string[] };
export const signEvent = { id: '88888888-8888-4888-8888-888888888888', organization_id: ORG, document_id: DOCUMENT, revision: 1, action: 'sign' as const, values: { signer_name: '김고객', strokes: [[[0, 0], [1, 1]]], confirmed: true }, actor_id: USER, occurred_at: stamp, content_hash: 'a'.repeat(64) };
export const file = { id: FILE, organization_id: ORG, uploaded_by: USER, original_name: '가격표.pdf', content_type: 'application/pdf', size_bytes: 2048, version_number:1, is_archived: false, created_at: stamp, updated_at: stamp, folder_id: null, tags: [] as string[] };

export type Call = { method: string; path: string; body: unknown };
export type Handler = (call: Call) => unknown;

/** api.call 을 흉내 내는 가짜 클라이언트. 응답은 실제 zod 스키마로 한 번 더 검증해 서버 형식과의 어긋남을 잡는다. */
export function fakeApi(handler: Handler, platform: Record<string, unknown> = {}, storageUsage: FileStorageUsage = {organization_id:ORG,used_bytes:0,reserved_bytes:0,organization_quota_bytes:5368709120,plan_quota_bytes:null,quota_bytes:5368709120,available_bytes:5368709120}) {
  const calls: Call[] = [];
  let pendingUploadFile:unknown=file;
  const call = vi.fn(async (method: string, path: string, schema: z.ZodType, body?: unknown) => {
    const entry = { method, path, body };
    calls.push(entry);
    let response=method==='GET'&&path.endsWith('/file-storage/usage')
      ? storageUsage
      : await handler(entry);
    if(method==='POST'&&path.endsWith('/upload-url')&&typeof response==='object'&&response!==null&&'file' in response)pendingUploadFile=(response as {file:unknown}).file;
    if(method==='POST'&&path.endsWith('/complete-upload')&&Array.isArray(response))response=pendingUploadFile;
    if(method==='DELETE'&&path.includes('/file-storage/uploads/')&&Array.isArray(response)&&response.length===0)response={released:true};
    return schema.parse(response);
  });
  const api = { call, callVoid: vi.fn(), filePlatform: { kind: 'browser', uploadBinary: vi.fn(async () => undefined), downloadBinary: vi.fn(async () => new Uint8Array([1, 2, 3])), ...platform } };
  return { api: api as unknown as ApiClient, calls, call, platform: api.filePlatform as unknown as Record<string, ReturnType<typeof vi.fn>> };
}

export const httpError = (status: number) => new ApiError(status, `HTTP_${status}`, `요청에 실패했습니다. (${status})`, status >= 500 || status === 0);
export const networkError = () => new ApiError(0, 'NETWORK_ERROR', '네트워크에 연결할 수 없습니다.', true);

export function renderWithHosts(ui: ReactElement) {
  return render(<>{ui}<ConfirmDialog /><NoticeHost /></>);
}
export const matches = (call: Call, method: string, pattern: RegExp) => call.method === method && pattern.test(call.path);
