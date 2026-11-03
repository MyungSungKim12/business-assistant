import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { build, config } from './testkit.js';

const token = 'A'.repeat(43);

describe('고객 모바일 문서 서명', () => {
  it('공개 서명 페이지는 링크 토큰을 경로·쿼리에 노출하지 않고 캐시와 프레임을 차단한다', async () => {
    const { app } = build();
    const result = await app.inject({ url: '/api/v1/public/document-signatures#secret' });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(result.body).not.toContain('secret');
    expect(result.body).toContain('history.replaceState');
    await app.close();
  });

  it('공개 미리보기는 토큰 해시만 Supabase로 보내고 필요한 발급본만 돌려준다', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const fetcher = (async (input: URL | string, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify([{ title: '동의서', content: '발급 시 고정 내용', template_version: 3, expires_at: '2030-01-01T00:00:00Z', organization_id: 'private' }]), { status: 200 });
    }) as typeof fetch;
    const { app } = build();
    const { registerPublicDocumentSignatureRoutes } = await import('./public-signatures.js');
    const publicApp = (await import('fastify')).default();
    registerPublicDocumentSignatureRoutes(publicApp, config, fetcher);
    const response = await publicApp.inject({ method: 'POST', url: '/api/v1/public/document-signatures/preview', payload: { token } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ title: '동의서', content: '발급 시 고정 내용', template_version: 3, expires_at: '2030-01-01T00:00:00Z' });
    expect(calls[0].url).toContain('/rpc/preview_customer_document_signature');
    expect(calls[0].body).toEqual({ p_token_hash: createHash('sha256').update(token).digest('hex') });
    expect(JSON.stringify(calls[0].body)).not.toContain(token);
    expect(calls[0].headers.has('authorization')).toBe(false);
    await app.close(); await publicApp.close();
  });

  it('서명 요청 입력 검증 후에만 토큰 해시와 서명 자료를 RPC로 전달한다', async () => {
    let body: Record<string, unknown> | undefined;
    const fetcher = (async (_input: URL | string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response('true', { status: 200 });
    }) as typeof fetch;
    const { registerPublicDocumentSignatureRoutes } = await import('./public-signatures.js');
    const app = (await import('fastify')).default();
    registerPublicDocumentSignatureRoutes(app, config, fetcher);
    const payload = { token, operation_id: '14ab7788-2d3e-43bd-b34c-e04b09f7d4bb', signer_name: '김고객', confirmed: true, strokes: [[[0, 0], [0.5, 0.7]]] };
    const response = await app.inject({ method: 'POST', url: '/api/v1/public/document-signatures/sign', payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ signed: true });
    expect(body).toEqual({ p_token_hash: createHash('sha256').update(token).digest('hex'), p_operation_id: payload.operation_id, p_signer_name: payload.signer_name, p_strokes: payload.strokes });
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/public/document-signatures/sign', payload: { ...payload, strokes: [[[0, 0], [0, 0]]] } });
    expect(invalid.statusCode).toBe(422);
    const withoutConsent = await app.inject({ method: 'POST', url: '/api/v1/public/document-signatures/sign', payload: { ...payload, confirmed: undefined } });
    expect(withoutConsent.statusCode).toBe(422);
    expect(body).toMatchObject({ p_operation_id: payload.operation_id });
    await app.close();
  });
});
