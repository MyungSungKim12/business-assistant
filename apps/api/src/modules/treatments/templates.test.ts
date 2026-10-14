import { describe, expect, it } from 'vitest';
import { build, headers, json, operationId, organizationId, otherOrganizationId, type Call } from './fixtures.js';

const base = `/api/v1/organizations/${organizationId}/treatment-templates`;
const templateId = '29cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const row = (over: Record<string, unknown> = {}) => ({
  id: templateId, organization_id: organizationId, name: '기본 페이셜', category: '피부', treatment_name: '수분 관리', notes: '1. 클렌징\n2. 팩',
  consultation_goal: '수분 개선', consultation_plan: '4주 간격', version: 1, updated_at: '2026-10-14T01:00:00Z', ...over,
});
const table = (call: Call) => call.url.pathname.split('/').pop();

describe('시술 프로토콜 템플릿 (TRT-12)', () => {
  it('목록은 이름순으로 읽고 member도 읽을 수 있다', async () => {
    const { app, calls, access } = build({ role: 'member', provider: () => json([row()]) });
    const result = await app.inject({ url: base, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual([row()]);
    expect(table(calls[0])).toBe('treatment_protocol_templates');
    expect(calls[0].url.searchParams.get('organization_id')).toBe(`eq.${organizationId}`);
    expect(calls[0].url.searchParams.get('order')).toBe('name.asc');
    expect(access).toEqual([{ feature: 'crm.basic', write: false }]);
  });

  it('다른 조직 행이 섞인 응답은 닫힌 실패(503)다', async () => {
    const { app } = build({ provider: () => json([row({ organization_id: otherOrganizationId })]) });
    expect((await app.inject({ url: base, headers })).statusCode).toBe(503);
  });

  it('생성은 조직을 경로에서 정하고 빈 칸은 기본값으로 채운다', async () => {
    const { app, calls, access } = build({ provider: () => json([row()], 201) });
    const result = await app.inject({ method: 'POST', url: base, headers, payload: { name: '  기본 페이셜  ' } });
    expect(result.statusCode).toBe(201);
    expect(calls[0].body).toEqual({ organization_id: organizationId, name: '기본 페이셜', category: '', treatment_name: '', notes: '', consultation_goal: '', consultation_plan: '' });
    expect(access.at(-1)).toEqual({ feature: 'crm.basic', write: true });
  });

  it('member의 쓰기는 거부되고 DB에 닿지 않는다', async () => {
    const { app, calls } = build({ role: 'member' });
    expect((await app.inject({ method: 'POST', url: base, headers, payload: { name: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `${base}/${templateId}`, headers, payload: { name: 'x', expected_version: 1 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `${base}/${templateId}`, headers })).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('잘못된 입력은 422이고 DB에 닿지 않는다', async () => {
    const { app, calls } = build();
    const post = (payload: unknown) => app.inject({ method: 'POST', url: base, headers, payload: payload as never });
    expect((await post({})).statusCode).toBe(422);
    expect((await post({ name: '   ' })).statusCode).toBe(422);
    expect((await post({ name: '가'.repeat(121) })).statusCode).toBe(422);
    expect((await post({ name: 'x', notes: '가'.repeat(10_001) })).statusCode).toBe(422);
    expect((await post({ name: 'x', consultation_goal: '가'.repeat(2_001) })).statusCode).toBe(422);
    expect((await post({ name: 'x', consultation_plan: '가'.repeat(5_001) })).statusCode).toBe(422);
    expect((await post({ name: 'x', organization_id: otherOrganizationId })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: `${base}/${templateId}`, headers, payload: { name: 'x' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: `${base}/not-a-uuid`, headers, payload: { name: 'x', expected_version: 1 } })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('수정은 보낸 필드만 version 조건과 함께 갱신하고 기본값으로 덮어쓰지 않는다', async () => {
    const { app, calls } = build({ provider: () => json([row({ notes: '수정됨', version: 2 })]) });
    const result = await app.inject({ method: 'PATCH', url: `${base}/${templateId}`, headers, payload: { notes: '수정됨', expected_version: 1 } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ notes: '수정됨', version: 2 });
    expect(calls[0].body).toEqual({ notes: '수정됨' });
    expect(calls[0].url.searchParams.get('version')).toBe('eq.1');
    expect(calls[0].url.searchParams.get('id')).toBe(`eq.${templateId}`);
    expect(calls[0].url.searchParams.get('organization_id')).toBe(`eq.${organizationId}`);
  });

  it('오래된 버전은 409, 없는 템플릿은 404로 가른다', async () => {
    const stale = build({ provider: (call) => (call.method === 'PATCH' ? json([]) : json([{ id: templateId }])) });
    expect((await stale.app.inject({ method: 'PATCH', url: `${base}/${templateId}`, headers, payload: { name: 'x', expected_version: 1 } })).statusCode).toBe(409);
    const missing = build({ provider: () => json([]) });
    expect((await missing.app.inject({ method: 'PATCH', url: `${base}/${templateId}`, headers, payload: { name: 'x', expected_version: 1 } })).statusCode).toBe(404);
  });

  it('같은 이름(23505)과 한도 위반(23514)을 409·422로 매핑한다', async () => {
    const dup = build({ provider: () => json({ code: '23505', message: 'duplicate' }, 409) });
    expect((await dup.app.inject({ method: 'POST', url: base, headers, payload: { name: '중복' } })).statusCode).toBe(409);
    const bad = build({ provider: () => json({ code: '23514', message: 'check' }, 400) });
    expect((await bad.app.inject({ method: 'POST', url: base, headers, payload: { name: '한도' } })).statusCode).toBe(422);
  });

  it('삭제는 존재를 확인하고 204를 돌려주며, 지워지지 않았으면 권한 없음(403)이다', async () => {
    let deleted = false;
    const ok = build({ provider: (call) => { if (call.method === 'DELETE') { deleted = true; return json([]); } return json(deleted ? [] : [{ id: templateId }]); } });
    expect((await ok.app.inject({ method: 'DELETE', url: `${base}/${templateId}`, headers })).statusCode).toBe(204);
    const blocked = build({ provider: (call) => (call.method === 'DELETE' ? json([]) : json([{ id: templateId }])) });
    expect((await blocked.app.inject({ method: 'DELETE', url: `${base}/${templateId}`, headers })).statusCode).toBe(403);
    const missing = build({ provider: () => json([]) });
    expect((await missing.app.inject({ method: 'DELETE', url: `${base}/${templateId}`, headers })).statusCode).toBe(404);
  });

  it('인증 토큰이 없으면 401이고 기능이 없으면 403이다', async () => {
    const { app } = build();
    expect((await app.inject({ url: base })).statusCode).toBe(401);
    const noFeature = build({ features: [] });
    expect((await noFeature.app.inject({ url: base, headers })).statusCode).toBe(403);
    void operationId;
  });
});
