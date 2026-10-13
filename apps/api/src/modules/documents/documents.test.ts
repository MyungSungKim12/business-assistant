import { describe, expect, it } from 'vitest';
import { auth, build, CUSTOMER, DOCUMENT, document, expectNoLeak, issued, ORG, orgPath, preview, TEMPLATE, template, TREATMENT, treatmentPath, USER } from './testkit.js';

const post = (app: ReturnType<typeof build>['app'], url: string, payload: unknown, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url, headers, payload: payload as never });

describe('문서 목록·작성', () => {
  it('토큰·멤버십·기능이 없으면 거부한다', async () => {
    const { app } = build({ features: ['crm.basic'] });
    expect((await app.inject({ url: orgPath('documents') })).statusCode).toBe(401);
    expect((await app.inject({ url: orgPath('documents'), headers: { authorization: 'Bearer outsider' } })).statusCode).toBe(403);
    expect((await app.inject({ url: orgPath('documents'), headers: auth })).statusCode).toBe(403);
  });

  it('목록은 조직으로 한정하고 멤버도 읽을 수 있다', async () => {
    const { app, calls, access } = build({ role: 'member', respond: () => ({ body: [document] }) });
    const result = await app.inject({ url: orgPath('documents'), headers: auth });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual([document]);
    expect(calls[0].url.pathname).toBe('/rest/v1/documents');
    expect(calls[0].url.searchParams.get('organization_id')).toBe(`eq.${ORG}`);
    expect(calls[0].headers.Authorization).toBe('Bearer user-token');
    expect(access).toEqual([{ feature: 'document.template', write: false }]);
  });

  it('다른 조직 행이 섞여 오면 안전한 503으로 막는다', async () => {
    const { app } = build({ respond: () => ({ body: [{ ...document, organization_id: USER }] }) });
    const result = await app.inject({ url: orgPath('documents'), headers: auth });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ detail: 'Document service unavailable' });
  });

  it('작성: 제목을 다듬고 작성자와 기본값을 넣어 201로 돌려준다', async () => {
    const { app, calls } = build({ respond: (call) => (call.url.pathname === '/auth/v1/user' ? { body: { id: USER } } : { body: [document] }) });
    const result = await post(app, orgPath('documents'), { title: ' New doc ', template_id: TEMPLATE });
    expect(result.statusCode).toBe(201);
    const write = calls.find((call) => call.method === 'POST')!;
    expect(write.body).toEqual({ title: 'New doc', content: '', template_id: TEMPLATE, status: 'draft', organization_id: ORG, created_by: USER });
    expect(write.headers.Prefer).toBe('return=representation');
  });

  it('작성은 owner/admin만, 검증 실패는 저장소를 호출하지 않는다', async () => {
    const member = build({ role: 'member' });
    expect((await post(member.app, orgPath('documents'), { title: 'Doc' })).statusCode).toBe(403);
    expect(member.calls).toEqual([]);
    const { app, calls } = build();
    const invalid = [{ title: '' }, { title: null }, { title: 'x'.repeat(201) }, { title: 'Doc', status: 'bad' }, { title: 'Doc', content: 'x'.repeat(100_001) }, { title: 'Doc', extra: 1 }, { title: 'Doc', template_id: 'bad' }];
    for (const payload of invalid) expect((await post(app, orgPath('documents'), payload)).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('참조 검증 실패(400)는 장애가 아니라 422, 그 외는 안전한 503', async () => {
    const invalid = build({ respond: (call) => (call.url.pathname === '/auth/v1/user' ? { body: { id: USER } } : { status: 400, body: { message: 'private row' } }) });
    const rejected = await post(invalid.app, orgPath('documents'), { title: 'Doc' });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.body).not.toContain('private');
    const down = build({ respond: () => ({ status: 500, body: { message: 'private' } }) });
    const result = await down.app.inject({ url: orgPath('documents'), headers: auth });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ detail: 'Document service unavailable' });
  });

  it('수정: 일부 필드만 PATCH하고 없으면 404, 빈 수정·null은 422', async () => {
    const { app, calls } = build({ respond: (call) => ({ body: call.url.searchParams.get('id') === `eq.${DOCUMENT}` ? [{ ...document, status: 'final' }] : [] }) });
    const url = orgPath(`documents/${DOCUMENT}`);
    const ok = await app.inject({ method: 'PATCH', url, headers: auth, payload: { status: 'final' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('final');
    expect(calls[0].body).toEqual({ status: 'final' });
    expect(calls[0].url.searchParams.get('organization_id')).toBe(`eq.${ORG}`);
    expect((await app.inject({ method: 'PATCH', url: orgPath('documents/49cc39fd-8e8c-4df8-a623-1f23a3a936bd'), headers: auth, payload: { status: 'final' } })).statusCode).toBe(404);
    for (const payload of [{}, { template_id: null }, { title: null }, { status: 'bad' }]) expect((await app.inject({ method: 'PATCH', url, headers: auth, payload })).statusCode).toBe(422);
  });
});

describe('문서 템플릿 버전', () => {
  const mutation = (extra: Record<string, unknown> = {}) => ({ operation_id: USER, expected_revision: 3, action: 'publish', ...extra });
  const url = orgPath(`document-templates/${TEMPLATE}/mutations`);

  it('목록·게시 이력은 멤버도 조회한다', async () => {
    const version = { template_id: TEMPLATE, organization_id: ORG, version: 1, name: 'n', description: '', content: 'c', published_by: USER, published_at: '2030-01-01T00:00:00Z' };
    const { app, calls } = build({ role: 'member', respond: (call) => ({ body: call.url.pathname.endsWith('versions') ? [version] : call.url.pathname.endsWith('document_template_versions') ? [{ ...version, extra: 'x' }] : [template] }) });
    expect((await app.inject({ url: orgPath('document-templates'), headers: auth })).json()).toEqual([template]);
    const versions = await app.inject({ url: orgPath(`document-templates/${TEMPLATE}/versions`), headers: auth });
    expect(versions.statusCode).toBe(200);
    expect(versions.json()).toEqual([version]);
    const query = calls[1].url.searchParams;
    expect(query.get('template_id')).toBe(`eq.${TEMPLATE}`);
    expect(query.get('order')).toBe('version.desc');
  });

  it('변경은 RPC에 조직·템플릿·낙관적 revision·operation_id를 그대로 전달한다', async () => {
    const { app, calls } = build({ respond: () => ({ body: [template] }) });
    const saved = await post(app, url, mutation({ action: 'save', values: { name: ' Name ', description: 'd', content: 'c' } }));
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual(template);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/mutate_document_template');
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_template_id: TEMPLATE, p_expected_revision: 3, p_operation_id: USER, p_action: 'save', p_values: { name: 'Name', description: 'd', content: 'c' } });
    await post(app, url, mutation());
    expect((calls[1].body as { p_values: unknown }).p_values).toEqual({});
  });

  it.each([
    [{ action: 'create', expected_revision: 3, values: { name: 'n', description: '', content: '' } }],
    [{ action: 'save', expected_revision: 3 }],
    [{ action: 'publish', values: { name: 'n', description: '', content: '' } }],
    [{ action: 'create', expected_revision: 0 }],
    [{ action: 'save', expected_revision: 3, values: { name: ' ', description: '', content: '' } }],
    [{ action: 'save', expected_revision: 3, values: { name: 'n', description: '', content: 'x'.repeat(100_001) } }],
    [{ expected_revision: -1 }], [{ operation_id: 'bad' }], [{ action: 'delete' }], [{ extra: 1 }],
  ])('잘못된 변경 요청 %j 은 저장소에 닿기 전에 422', async (change) => {
    const { app, calls } = build();
    expect((await post(app, url, mutation(change))).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('권한: 기능 없음·멤버·미인증은 변경 전에 거부한다', async () => {
    expect((await post(build({ features: [] }).app, url, mutation())).statusCode).toBe(403);
    const member = build({ role: 'member' });
    expect((await post(member.app, url, mutation())).statusCode).toBe(403);
    expect(member.calls).toEqual([]);
    expect((await post(build().app, url, mutation(), {})).statusCode).toBe(401);
  });

  it.each([['P0001', 409], ['P0002', 404], ['42501', 403], ['22023', 422], ['23514', 422], ['22P02', 422]])('DB 오류 %s 는 %i 로 매핑하고 원문을 숨긴다', async (code, status) => {
    const { app } = build({ respond: () => ({ status: 400, body: { code, message: 'private patient data' } }) });
    const result = await post(app, url, mutation());
    expect(result.statusCode).toBe(status);
    expect(result.body).not.toContain('private');
  });

  it('코드 없는 400 은 422(Python 어댑터와 동일), 5xx·빈 결과는 503', async () => {
    expect((await post(build({ respond: () => ({ status: 400, body: { message: 'bad' } }) }).app, url, mutation())).statusCode).toBe(422);
    expect((await post(build({ respond: () => ({ status: 500, body: { code: 'XX000' } }) }).app, url, mutation())).statusCode).toBe(503);
    expect((await post(build({ respond: () => ({ body: [] }) }).app, url, mutation())).statusCode).toBe(503);
  });

  it('예전 직접 생성·수정 경로는 버전 우회를 막는다', async () => {
    const { app, calls } = build();
    const created = await post(app, orgPath('document-templates'), { name: ' New ', content: 'Body' });
    expect(created.statusCode).toBe(409);
    expect(created.json()).toEqual({ detail: 'Use the versioned template mutations endpoint' });
    const patched = await app.inject({ method: 'PATCH', url: orgPath(`document-templates/${TEMPLATE}`), headers: auth, payload: { name: 'x' } });
    expect(patched.statusCode).toBe(409);
    expect((await post(app, orgPath('document-templates'), { name: '' })).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });
});

describe('시술 문서 미리보기·발행·이력', () => {
  const body = { template_id: TEMPLATE, operation_id: USER, expected_preview: preview };

  it('모든 라우트는 crm.basic 과 document.template 를 모두 요구한다', async () => {
    for (const features of [['crm.basic'], ['document.template']]) {
      const { app } = build({ features });
      expect((await post(app, treatmentPath('documents/preview'), { template_id: TEMPLATE })).statusCode).toBe(403);
      expect((await app.inject({ url: treatmentPath(), headers: auth })).statusCode).toBe(403);
    }
    expect((await build().app.inject({ url: treatmentPath() })).statusCode).toBe(401);
  });

  it('멤버는 미리보기·이력을 보지만 발행은 못 한다', async () => {
    const { app, calls } = build({ role: 'member', respond: (call) => ({ body: call.url.pathname.includes('preview_treatment') ? preview : call.url.pathname.endsWith('treatment_records') ? [{ id: TREATMENT }] : [issued] }) });
    expect((await post(app, treatmentPath('documents/preview'), { template_id: TEMPLATE })).json()).toEqual(preview);
    expect((await app.inject({ url: treatmentPath(), headers: auth })).statusCode).toBe(200);
    const before = calls.length;
    expect((await post(app, treatmentPath(), body)).statusCode).toBe(403);
    expect(calls).toHaveLength(before);
  });

  it('미리보기 RPC 는 고객·시술·템플릿 범위를 전달한다', async () => {
    const { app, calls } = build({ respond: () => ({ body: preview }) });
    await post(app, treatmentPath('documents/preview'), { template_id: TEMPLATE });
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/preview_treatment_document');
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_customer_id: CUSTOMER, p_treatment_id: TREATMENT, p_template_id: TEMPLATE });
  });

  it('발행은 검토본·operation_id 를 보존하고 내부 필드를 숨긴다', async () => {
    const { app, calls } = build({ respond: () => ({ body: [issued] }) });
    const result = await post(app, treatmentPath(), body);
    expect(result.statusCode).toBe(201);
    expectNoLeak(result.body);
    expect(calls[0].body).toMatchObject({ p_template_id: TEMPLATE, p_operation_id: USER, p_expected_preview: preview });
  });

  it('이력은 상위 시술을 확인한 뒤 최신순으로 조회하고, 시술이 없으면 빈 목록이 아니라 404', async () => {
    const { app, calls } = build({ respond: (call) => ({ body: call.url.pathname.endsWith('treatment_records') ? [{ id: TREATMENT }] : [issued] }) });
    const result = await app.inject({ url: treatmentPath(), headers: auth });
    expect(result.statusCode).toBe(200);
    expectNoLeak(result.body);
    expect(calls[0].url.pathname).toBe('/rest/v1/treatment_records');
    expect(calls[1].url.searchParams.get('order')).toBe('issued_at.desc,id.desc');
    expect(calls[1].url.searchParams.get('treatment_id')).toBe(`eq.${TREATMENT}`);
    const missing = build({ respond: () => ({ body: [] }) });
    expect((await missing.app.inject({ url: treatmentPath(), headers: auth })).statusCode).toBe(404);
    expect(missing.calls).toHaveLength(1);
  });

  it.each([[{}], [{ template_id: TEMPLATE, operation_id: USER }], [{ ...body, operation_id: 'bad' }], [{ ...body, extra: 1 }], [{ ...body, expected_preview: 'x' }]])('잘못된 발행 요청 %j 은 422', async (payload) => {
    const { app, calls } = build();
    expect((await post(app, treatmentPath(), payload)).statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it('위조된 고객 필드가 있는 미리보기 요청은 422', async () => {
    expect((await post(build().app, treatmentPath('documents/preview'), { template_id: TEMPLATE, customer: { name: 'forged' } })).statusCode).toBe(422);
  });

  it.each([['P0001', 409], ['P0002', 404], ['42501', 403], ['22023', 422], ['XX000', 503]])('DB 오류 %s 는 %i', async (code, status) => {
    const { app } = build({ respond: () => ({ status: 400, body: { code, message: 'private' } }) });
    for (const result of [await post(app, treatmentPath('documents/preview'), { template_id: TEMPLATE }), await post(app, treatmentPath(), body)]) {
      expect(result.statusCode).toBe(status);
      expect(result.body).not.toContain('private');
    }
  });

  it('형식이 깨진 응답은 안전한 503', async () => {
    for (const payload of [[], [{ bad: true }], 'not object', { template_id: 'bad' }]) expect((await post(build({ respond: () => ({ body: payload }) }).app, treatmentPath('documents/preview'), { template_id: TEMPLATE })).statusCode).toBe(503);
    for (const payload of [{}, [], [issued, issued], [{ id: 'bad' }]]) expect((await post(build({ respond: () => ({ body: payload }) }).app, treatmentPath(), body)).statusCode).toBe(503);
  });
});
