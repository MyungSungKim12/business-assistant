import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocumentPage } from './DocumentPage';
import { document, fakeApi, httpError, matches, networkError, ORG, published, renderWithHosts, template, TEMPLATE, type Call } from './testkit';

const base = (call: Call): unknown => {
  if (matches(call, 'GET', /\/documents$/)) return [document];
  if (matches(call, 'GET', /\/document-templates$/)) return [published, { ...template, id: '99999999-9999-4999-8999-999999999999', name: '초안 서식' }];
  if (matches(call, 'GET', /\/versions$/)) return [{ template_id: TEMPLATE, organization_id: ORG, version: 2, name: '시술 동의서', description: '', content: '게시된 내용', published_by: document.created_by, published_at: '2026-10-13T00:00:00Z' }];
  throw new Error(`unexpected ${call.method} ${call.path}`);
};
const openTemplates = () => fireEvent.click(screen.getByRole('tab', { name: '서식 관리' }));
const inTemplates = () => within(screen.getByLabelText('서식 관리'));
const inDocs = () => within(screen.getByLabelText('문서 목록·작성'));
const confirmDialog = async (label: string) => fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: label }));

describe('DocumentPage · 문서', () => {
  it('게시된 서식을 고르면 빈 본문을 채우고 초안을 작성한다', async () => {
    const { api, calls } = fakeApi((call) => (call.method === 'POST' ? { ...document, id: '77777777-7777-4777-8777-777777777778', title: '새 문서', template_id: TEMPLATE, content: published.content } : base(call)));
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText('안내문')).toBeInTheDocument();
    fireEvent.change(inDocs().getByLabelText('제목'), { target: { value: ' 새 문서 ' } });
    fireEvent.change(inDocs().getByLabelText('템플릿'), { target: { value: TEMPLATE } });
    expect(inDocs().getByLabelText('본문')).toHaveValue(published.content);
    expect(inDocs().queryByRole('option', { name: /초안 서식/ })).not.toBeInTheDocument();
    fireEvent.click(inDocs().getByRole('button', { name: '초안 작성' }));
    expect(await screen.findByText('새 문서')).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ title: '새 문서', content: published.content, template_id: TEMPLATE, status: 'draft' });
  });

  it('제목이 없으면 저장하지 못하고, 저장 실패 시 입력을 유지한다', async () => {
    const { api } = fakeApi((call) => { if (call.method === 'POST') throw httpError(500); return base(call); });
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('안내문');
    expect(inDocs().getByRole('button', { name: '초안 작성' })).toBeDisabled();
    fireEvent.change(inDocs().getByLabelText('제목'), { target: { value: '문서' } });
    fireEvent.change(inDocs().getByLabelText('본문'), { target: { value: '입력 중' } });
    fireEvent.click(inDocs().getByRole('button', { name: '초안 작성' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('입력 내용은 유지됩니다');
    expect(inDocs().getByLabelText('본문')).toHaveValue('입력 중');
  });

  it('기존 문서는 바뀐 필드만 PATCH 한다', async () => {
    const { api, calls } = fakeApi((call) => (call.method === 'PATCH' ? { ...document, status: 'final' } : base(call)));
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '안내문' }));
    await waitFor(() => expect(inDocs().getByLabelText('제목')).toHaveValue('안내문'));
    fireEvent.change(inDocs().getByLabelText('상태'), { target: { value: 'final' } });
    fireEvent.click(inDocs().getByRole('button', { name: '저장' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({ status: 'final' });
    expect(calls.find((call) => call.method === 'PATCH')!.path).toMatch(/\/documents\/55555555/);
  });

  it('작성 중인 내용이 있으면 다른 문서로 옮길 때 버릴지 묻는다', async () => {
    const { api } = fakeApi(base);
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    fireEvent.change(await inDocs().findByLabelText('제목'), { target: { value: '쓰던 글' } });
    fireEvent.click(screen.getByRole('button', { name: '안내문' }));
    await confirmDialog('취소');
    expect(inDocs().getByLabelText('제목')).toHaveValue('쓰던 글');
    fireEvent.click(screen.getByRole('button', { name: '안내문' }));
    await confirmDialog('버리기');
    await waitFor(() => expect(inDocs().getByLabelText('제목')).toHaveValue('안내문'));
  });

  it('읽기 전용(member)에서는 작성·저장 UI가 없다', async () => {
    const { api } = fakeApi(base);
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly />);
    fireEvent.click(await screen.findByRole('button', { name: '안내문' }));
    await waitFor(() => expect(inDocs().getByLabelText('제목')).toHaveAttribute('readonly'));
    expect(inDocs().queryByRole('button', { name: '저장' })).not.toBeInTheDocument();
    expect(inDocs().queryByRole('button', { name: '새 문서' })).not.toBeInTheDocument();
  });

  it('목록 오류는 다시 시도로 복구한다', async () => {
    let fail = true;
    const { api } = fakeApi((call) => { if (fail) throw httpError(503); return base(call); });
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText(/문서를 불러오지 못했습니다/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getAllByRole('button', { name: '다시 시도' })[0]);
    expect(await screen.findByText('안내문')).toBeInTheDocument();
  });
});

describe('DocumentPage · 서식 관리', () => {
  const select = async (name: RegExp) => {
    openTemplates();
    fireEvent.click(await inTemplates().findByRole('button', { name }));
    await waitFor(() => expect(inTemplates().getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true'));
  };

  it('초안 서식을 수정해 저장하면 revision 과 값을 보낸다', async () => {
    const { api, calls } = fakeApi((call) => (matches(call, 'POST', /mutations$/) ? { ...template, id: '99999999-9999-4999-8999-999999999999', name: '수정됨', revision: 2 } : base(call)));
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    await select(/초안 서식/);
    const name = inTemplates().getByLabelText('서식 이름');
    fireEvent.change(name, { target: { value: ' 수정됨 ' } });
    fireEvent.click(inTemplates().getByRole('button', { name: '초안 저장' }));
    await waitFor(() => expect(calls.some((call) => matches(call, 'POST', /mutations$/))).toBe(true));
    const request = calls.find((call) => matches(call, 'POST', /mutations$/))!;
    expect(request.body).toMatchObject({ action: 'save', expected_revision: 1, values: { name: '수정됨', content: template.content } });
    expect(typeof (request.body as { operation_id: string }).operation_id).toBe('string');
    expect(await inTemplates().findByText(/서식을 저장했습니다/)).toBeInTheDocument();
  });

  it('새 서식은 revision 0 의 create 로 만든다', async () => {
    const { api, calls } = fakeApi((call) => (matches(call, 'POST', /mutations$/) ? { ...template, name: '신규' } : base(call)));
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    openTemplates();
    fireEvent.click(await inTemplates().findByRole('button', { name: '새 서식' }));
    fireEvent.change(inTemplates().getByLabelText('서식 이름'), { target: { value: '신규' } });
    fireEvent.click(inTemplates().getByRole('button', { name: '초안 저장' }));
    await waitFor(() => expect(calls.some((call) => matches(call, 'POST', /mutations$/))).toBe(true));
    expect(calls.find((call) => matches(call, 'POST', /mutations$/))!.body).toMatchObject({ action: 'create', expected_revision: 0 });
  });

  it('이름이 비면 저장하지 않고, 게시는 변경을 먼저 저장하도록 막는다', async () => {
    const { api, calls } = fakeApi(base);
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    await select(/초안 서식/);
    fireEvent.change(inTemplates().getByLabelText('서식 이름'), { target: { value: ' ' } });
    fireEvent.click(inTemplates().getByRole('button', { name: '초안 저장' }));
    expect(await inTemplates().findByText(/이름은 필수/)).toBeInTheDocument();
    fireEvent.change(inTemplates().getByLabelText('서식 이름'), { target: { value: '변경' } });
    fireEvent.click(inTemplates().getByRole('button', { name: '게시' }));
    expect(await inTemplates().findByText('변경한 초안을 먼저 저장하세요.')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('게시는 확인 후 publish 를 보내고, 게시본은 읽기 전용이며 새 버전·폐기를 제공한다', async () => {
    const { api, calls } = fakeApi((call) => (matches(call, 'POST', /mutations$/) ? published : base(call)));
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    await select(/초안 서식/);
    fireEvent.click(inTemplates().getByRole('button', { name: '게시' }));
    await confirmDialog('게시');
    await waitFor(() => expect(calls.some((call) => matches(call, 'POST', /mutations$/))).toBe(true));
    expect(calls.find((call) => matches(call, 'POST', /mutations$/))!.body).toMatchObject({ action: 'publish', expected_revision: 1 });
    await waitFor(() => expect(inTemplates().getAllByText(/v2 · 게시됨/).length).toBeGreaterThan(1));
    expect(inTemplates().getByLabelText('서식 이름')).toHaveAttribute('readonly');
    expect(inTemplates().getByRole('button', { name: '새 버전 만들기' })).toBeEnabled();
    expect(inTemplates().getByRole('button', { name: '초안 저장' })).toBeDisabled();
    expect(inTemplates().getByRole('button', { name: '폐기' })).toBeEnabled();
  });

  it('게시 이력에서 게시본을 읽기 전용으로 조회한다', async () => {
    const { api } = fakeApi(base);
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    await select(/시술 동의서/);
    const history = await inTemplates().findByLabelText('게시 이력');
    await waitFor(() => expect(within(history).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(history, { target: { value: '2' } });
    expect(inTemplates().getByLabelText('본문')).toHaveValue('게시된 내용');
    expect(inTemplates().getByLabelText('본문')).toHaveAttribute('readonly');
    expect(inTemplates().getByRole('button', { name: '새 버전 만들기' })).toBeDisabled();
  });

  it('버전 충돌(409)이면 입력을 보존한 채 편집을 잠그고 새로고침을 안내한다', async () => {
    const { api } = fakeApi((call) => { if (matches(call, 'POST', /mutations$/)) throw httpError(409); return base(call); });
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    await select(/초안 서식/);
    fireEvent.change(inTemplates().getByLabelText('본문'), { target: { value: '내 수정' } });
    fireEvent.click(inTemplates().getByRole('button', { name: '초안 저장' }));
    expect(await inTemplates().findByRole('alert')).toHaveTextContent('다른 변경이 있습니다');
    expect(inTemplates().getByLabelText('본문')).toHaveValue('내 수정');
    expect(inTemplates().getByRole('button', { name: '초안 저장' })).toBeDisabled();
  });

  it('결과를 모르는 네트워크 오류는 같은 operation_id 로 재시도한다', async () => {
    let fail = true;
    const { api, calls } = fakeApi((call) => { if (matches(call, 'POST', /mutations$/)) { if (fail) throw networkError(); return { ...template, name: '재시도' }; } return base(call); });
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    await select(/초안 서식/);
    fireEvent.change(inTemplates().getByLabelText('서식 이름'), { target: { value: '재시도' } });
    fireEvent.click(inTemplates().getByRole('button', { name: '초안 저장' }));
    const retry = await inTemplates().findByRole('button', { name: '같은 요청 재시도' });
    expect(inTemplates().getByRole('button', { name: '초안 저장' })).toBeDisabled();
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(inTemplates().queryByRole('button', { name: '같은 요청 재시도' })).not.toBeInTheDocument());
    const sent = calls.filter((call) => matches(call, 'POST', /mutations$/)).map((call) => call.body as { operation_id: string });
    expect(sent).toHaveLength(2);
    expect(sent[1].operation_id).toBe(sent[0].operation_id);
  });

  it('자동 채움 항목을 본문에 삽입한다', async () => {
    const { api } = fakeApi(base);
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly={false} />);
    openTemplates();
    fireEvent.click(await inTemplates().findByRole('button', { name: '새 서식' }));
    fireEvent.change(inTemplates().getByLabelText('자동 채움 항목'), { target: { value: 'treatment.name' } });
    fireEvent.click(inTemplates().getByRole('button', { name: '자동 채움 항목 삽입' }));
    expect(inTemplates().getByLabelText('본문')).toHaveValue('{{treatment.name}}');
  });

  it('읽기 전용에서는 서식을 볼 수만 있다', async () => {
    const { api } = fakeApi(base);
    renderWithHosts(<DocumentPage api={api} organizationId={ORG} readOnly />);
    await select(/시술 동의서/);
    expect(inTemplates().queryByRole('button', { name: '새 서식' })).not.toBeInTheDocument();
    expect(inTemplates().queryByRole('button', { name: '초안 저장' })).not.toBeInTheDocument();
    expect(inTemplates().queryByRole('button', { name: '게시' })).not.toBeInTheDocument();
    expect(inTemplates().getByLabelText('서식 이름')).toHaveAttribute('readonly');
  });
});
