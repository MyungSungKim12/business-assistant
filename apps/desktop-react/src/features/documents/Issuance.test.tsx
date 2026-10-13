import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentModal } from './ConsentModal';
import { TreatmentDocumentModal } from './TreatmentDocumentModal';
import { CUSTOMER, DOCUMENT, fakeApi, httpError, issued, matches, networkError, ORG, preview, published, renderWithHosts, signEvent, template, TEMPLATE, TREATMENT, USER, type Call } from './testkit';

const documentsPath = /\/treatments\/[^/]+\/documents$/;
const eventsPath = /\/documents\/[^/]+\/events$/;
const scope = { organizationId: ORG, customerId: CUSTOMER, treatmentId: TREATMENT };

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn() } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
});

describe('TreatmentDocumentModal · 발행', () => {
  const handler = (extra: (call: Call) => unknown = () => undefined) => (call: Call): unknown => {
    const custom = extra(call);
    if (custom !== undefined) return custom;
    if (matches(call, 'GET', /\/document-templates$/)) return [published, template];
    if (matches(call, 'GET', documentsPath)) return [];
    if (matches(call, 'POST', /\/documents\/preview$/)) return preview;
    if (matches(call, 'POST', documentsPath)) return issued;
    throw new Error(`unexpected ${call.method} ${call.path}`);
  };
  const open = async (api: Parameters<typeof TreatmentDocumentModal>[0]['api'], readOnly = false) => {
    const onClose = vi.fn();
    renderWithHosts(<TreatmentDocumentModal api={api} organizationId={ORG} customerId={CUSTOMER} treatmentId={TREATMENT} readOnly={readOnly} onClose={onClose} />);
    await screen.findByRole('option', { name: /시술 동의서 · v2/ });
    return onClose;
  };
  const review = async () => {
    fireEvent.change(screen.getByLabelText('서식'), { target: { value: TEMPLATE } });
    fireEvent.click(screen.getByRole('button', { name: '최신 정보로 미리보기' }));
    await screen.findByLabelText('발행 전 미리보기');
  };

  it('게시된 서식만 고르고 미리보기를 검토한 뒤 발행하면 이력에 보관한다', async () => {
    const { api, calls } = fakeApi(handler());
    await open(api);
    expect(screen.queryByRole('option', { name: /v1/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    await review();
    expect(screen.getByLabelText('발행 전 미리보기')).toHaveTextContent('안녕하세요 김고객');
    expect(screen.getByRole('button', { name: '검토한 내용으로 발행' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '검토한 내용으로 발행' }));
    expect(await screen.findByRole('list', { name: '발행 이력' })).toBeInTheDocument();
    const request = calls.find((call) => matches(call, 'POST', documentsPath))!;
    expect(request.body).toEqual({ template_id: TEMPLATE, operation_id: expect.any(String), expected_preview: preview });
    expect(screen.getByText(/서명은 아직 확인되지 않았습니다/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '발행 이력' })).getByRole('button', { name: /시술 동의서 · v2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '선택한 발행본 · 서명·교부·철회' })).toBeEnabled();
  });

  it('누락 항목이 있으면 발행할 수 없고 누락 항목 이름을 알려준다', async () => {
    const { api, calls } = fakeApi(handler((call) => (matches(call, 'POST', /\/preview$/) ? { ...preview, missing_fields: ['treatment.practitioner', 'x.unknown'] } : undefined)));
    await open(api);
    await review();
    expect(screen.getByText(/발행 불가 · 누락\/미지원 항목: 담당자, x.unknown/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: '검토한 내용으로 발행' })).toBeDisabled();
    expect(calls.some((call) => matches(call, 'POST', documentsPath))).toBe(false);
  });

  it('검토 중 원본이 바뀌면(409) 미리보기를 무효화하고 다시 검토하게 한다', async () => {
    const { api } = fakeApi(handler((call) => { if (matches(call, 'POST', documentsPath)) throw httpError(409); return undefined; }));
    await open(api);
    await review();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '검토한 내용으로 발행' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('미리보기를 다시 불러와 검토하세요');
    expect(screen.queryByLabelText('발행 전 미리보기')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '같은 발행 요청 재시도' })).not.toBeInTheDocument();
  });

  it('결과를 알 수 없는 오류는 같은 operation_id 로 재시도해 중복 발행을 막는다', async () => {
    let fail = true;
    const { api, calls } = fakeApi(handler((call) => { if (matches(call, 'POST', documentsPath)) { if (fail) throw networkError(); return issued; } return undefined; }));
    await open(api);
    await review();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '검토한 내용으로 발행' }));
    const retry = await screen.findByRole('button', { name: '같은 발행 요청 재시도' });
    fail = false;
    fireEvent.click(retry);
    await screen.findByRole('list', { name: '발행 이력' });
    const sent = calls.filter((call) => matches(call, 'POST', documentsPath)).map((call) => (call.body as { operation_id: string }).operation_id);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it('읽기 전용에서는 미리보기만 가능하고 발행 UI가 없다', async () => {
    const { api } = fakeApi(handler());
    await open(api, true);
    await review();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '검토한 내용으로 발행' })).not.toBeInTheDocument();
  });

  it('검토만 하고 닫으려 하면 확인을 받는다', async () => {
    const { api } = fakeApi(handler());
    const onClose = await open(api);
    await review();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getAllByRole('button', { name: '닫기' }).at(-1)!);
    const dialog = await screen.findByRole('dialog', { name: '문서 발행' });
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: '닫기' }).at(-1)!);
    fireEvent.click(within(await screen.findByRole('dialog', { name: '문서 발행' })).getAllByRole('button', { name: '닫기' }).at(-1)!);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('게시된 서식이 없으면 안내하고, 이력은 비었음을 알린다', async () => {
    const { api } = fakeApi(handler((call) => (matches(call, 'GET', /\/document-templates$/) ? [template] : undefined)));
    renderWithHosts(<TreatmentDocumentModal api={api} organizationId={ORG} customerId={CUSTOMER} treatmentId={TREATMENT} readOnly={false} onClose={vi.fn()} />);
    expect(await screen.findByText('게시된 서식이 없습니다. 문서 메뉴에서 서식을 게시하세요.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '발행 이력' }));
    expect(screen.getByText('이 시술에 발행한 문서가 없습니다.')).toBeInTheDocument();
  });

  it('불러오기 실패는 새로고침으로 복구한다', async () => {
    let fail = true;
    const { api } = fakeApi(handler((call) => { if (fail && matches(call, 'GET', documentsPath)) throw httpError(404); return undefined; }));
    renderWithHosts(<TreatmentDocumentModal api={api} organizationId={ORG} customerId={CUSTOMER} treatmentId={TREATMENT} readOnly={false} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('고객·시술 또는 서식이 없습니다');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '서식·이력 새로고침' }));
    await screen.findByRole('option', { name: /시술 동의서 · v2/ });
  });

  it('발행 이력에서 발행본의 서명 창으로 들어가고 닫으면 돌아온다', async () => {
    const { api } = fakeApi(handler((call) => (matches(call, 'GET', documentsPath) ? [issued] : matches(call, 'GET', eventsPath) ? [] : undefined)));
    await open(api);
    fireEvent.click(screen.getByRole('tab', { name: '발행 이력' }));
    fireEvent.click(screen.getByRole('button', { name: /시술 동의서 · v2/ }));
    fireEvent.click(screen.getByRole('button', { name: '선택한 발행본 · 서명·교부·철회' }));
    expect(await screen.findByText('발행본 · 서명·교부·철회', { selector: 'h2' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '닫기' }).at(-1)!);
    expect(await screen.findByText('시술 문서 · 발행 및 이력', { selector: 'h2' })).toBeInTheDocument();
  });
});

describe('ConsentModal · 서명·교부·철회', () => {
  const open = async (events: unknown[], options: { readOnly?: boolean; extra?: (call: Call) => unknown } = {}) => {
    const fake = fakeApi((call) => {
      const custom = options.extra?.(call);
      if (custom !== undefined) return custom;
      if (matches(call, 'GET', eventsPath)) return events;
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });
    const onClose = vi.fn();
    renderWithHosts(<ConsentModal api={fake.api} scope={scope} document={issued} readOnly={options.readOnly ?? false} onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('consent-state')).not.toHaveTextContent('확인 중'));
    return { ...fake, onClose };
  };
  const draw = () => {
    const pad = screen.getByLabelText('고객 손서명 입력');
    fireEvent.pointerDown(pad, { clientX: 10, clientY: 10, pointerId: 1, pointerType: 'touch', button: 0 });
    fireEvent.pointerMove(pad, { clientX: 60, clientY: 50, pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerUp(pad, { clientX: 90, clientY: 90, pointerId: 1, pointerType: 'touch' });
  };
  const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
  const saved = (action: 'sign' | 'deliver' | 'revoke', revision: number, values: Record<string, unknown>) => ({ ...signEvent, id: `88888888-8888-4888-8888-88888888888${revision}`, revision, action, values });

  it('이름·서명·확인 체크가 모두 있어야 손서명을 저장하고, 저장하면 증빙 상태가 바뀐다', async () => {
    const { calls } = await open([], { extra: (call) => (matches(call, 'POST', eventsPath) ? saved('sign', 1, (call.body as { values: Record<string, unknown> }).values) : undefined) });
    expect(screen.getByTestId('consent-state')).toHaveTextContent('서명 미확인');
    fireEvent.click(screen.getByRole('button', { name: '이 발행본에 손서명 저장' }));
    expect(screen.getByText('서명자 이름, 손서명과 확인 체크가 필요합니다.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('서명자 이름'), { target: { value: ' 김고객 ' } });
    draw();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '이 발행본에 손서명 저장' }));
    await waitFor(() => expect(screen.getByTestId('consent-state')).toHaveTextContent('현장 손서명 기록됨'));
    const request = calls.find((call) => matches(call, 'POST', eventsPath))!;
    expect(request.body).toEqual({ expected_revision: 0, operation_id: expect.any(String), action: 'sign', values: { signer_name: '김고객', strokes: [[[0.1, 0.1], [0.6, 0.5], [0.9, 0.9]]], confirmed: true } });
    expect(request.path).toContain(`/documents/${DOCUMENT}/events`);
    tab('손서명');
    expect(screen.getByLabelText('서명자 이름')).toBeDisabled();
  });

  it('서명 전에는 교부·철회를 기록할 수 없다', async () => {
    await open([]);
    tab('교부 확인');
    expect(screen.getByRole('button', { name: '교부 확인 기록 추가' })).toBeDisabled();
    expect(screen.getByText('손서명이 기록된 뒤에 교부 확인을 남길 수 있습니다.')).toBeInTheDocument();
    tab('철회');
    expect(screen.getByRole('button', { name: '철회 기록 남기기' })).toBeDisabled();
  });

  it('서명 후 교부 확인은 현재 revision 을 기대값으로 보낸다', async () => {
    const { calls } = await open([signEvent], { extra: (call) => (matches(call, 'POST', eventsPath) ? saved('deliver', 2, (call.body as { values: Record<string, unknown> }).values) : undefined) });
    tab('교부 확인');
    fireEvent.change(screen.getByLabelText('교부 방법'), { target: { value: 'email' } });
    fireEvent.click(screen.getByRole('button', { name: '교부 확인 기록 추가' }));
    expect(screen.getByText(/수령인과 교부 확인 체크가 필요합니다/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('수령인'), { target: { value: '김고객' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '교부 확인 기록 추가' }));
    await screen.findByRole('list', { name: '기록 이력' });
    const request = calls.find((call) => matches(call, 'POST', eventsPath))!;
    expect(request.body).toEqual({ expected_revision: 1, operation_id: expect.any(String), action: 'deliver', values: { method: 'email', recipient: '김고객', reference: '', note: '', confirmed: true } });
    expect(screen.getByRole('button', { name: /2\. 교부 확인 기록/ })).toBeInTheDocument();
  });

  it('철회하면 되돌릴 수 없고 모든 입력이 잠긴다', async () => {
    await open([signEvent], { extra: (call) => (matches(call, 'POST', eventsPath) ? saved('revoke', 2, (call.body as { values: Record<string, unknown> }).values) : undefined) });
    tab('철회');
    fireEvent.click(screen.getByRole('button', { name: '철회 기록 남기기' }));
    expect(screen.getByText(/철회 사유\(2,000자 이내\)/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('철회 사유'), { target: { value: '고객 요청' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '철회 기록 남기기' }));
    await waitFor(() => expect(screen.getByTestId('consent-state')).toHaveTextContent('철회됨'));
    tab('철회');
    expect(screen.getByRole('button', { name: '철회 기록 남기기' })).toBeDisabled();
    tab('교부 확인');
    expect(screen.getByRole('button', { name: '교부 확인 기록 추가' })).toBeDisabled();
  });

  it('다른 기록이 먼저 추가되면(409) 입력을 보존한 채 잠그고, 새로고침하면 풀린다', async () => {
    let conflict = true;
    const { calls } = await open([], { extra: (call) => { if (matches(call, 'POST', eventsPath)) throw httpError(409); if (matches(call, 'GET', eventsPath) && !conflict) return [signEvent]; return undefined; } });
    fireEvent.change(screen.getByLabelText('서명자 이름'), { target: { value: '김고객' } });
    draw();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '이 발행본에 손서명 저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('다른 기록이 추가되었습니다');
    expect(screen.getByLabelText('서명자 이름')).toHaveValue('김고객');
    expect(screen.getByRole('button', { name: '이 발행본에 손서명 저장' })).toBeDisabled();
    conflict = false;
    fireEvent.click(screen.getByRole('button', { name: '이력 새로고침' }));
    await waitFor(() => expect(screen.getByTestId('consent-state')).toHaveTextContent('현장 손서명 기록됨'));
    expect(calls.filter((call) => matches(call, 'GET', eventsPath))).toHaveLength(2);
  });

  it('결과를 모르는 오류는 같은 operation_id·같은 서명으로 재시도한다', async () => {
    let fail = true;
    const { calls } = await open([], { extra: (call) => { if (matches(call, 'POST', eventsPath)) { if (fail) throw networkError(); return saved('sign', 1, (call.body as { values: Record<string, unknown> }).values); } return undefined; } });
    fireEvent.change(screen.getByLabelText('서명자 이름'), { target: { value: '김고객' } });
    draw();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '이 발행본에 손서명 저장' }));
    const retry = await screen.findByRole('button', { name: '같은 요청 재시도' });
    expect(screen.getByRole('button', { name: '이 발행본에 손서명 저장' })).toBeDisabled();
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('consent-state')).toHaveTextContent('현장 손서명 기록됨'));
    const sent = calls.filter((call) => matches(call, 'POST', eventsPath));
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toEqual(sent[0].body);
  });

  it('읽기 전용에서는 저장 UI 없이 이력만 조회한다', async () => {
    await open([signEvent], { readOnly: true });
    expect(screen.queryByRole('button', { name: '이 발행본에 손서명 저장' })).not.toBeInTheDocument();
    tab('전체 이력');
    fireEvent.click(screen.getByRole('button', { name: /1\. 현장 손서명/ }));
    expect(screen.getByLabelText('기록 상세')).toHaveTextContent('서명자: 김고객');
    expect(screen.getByLabelText('기록 상세')).toHaveTextContent(`기록자 ID: ${USER}`);
  });

  it('이력을 못 불러오면 오류를 알리고 입력을 막는다', async () => {
    fakeApi(() => []);
    const fake = fakeApi((call) => { if (matches(call, 'GET', eventsPath)) throw httpError(404); return []; });
    renderWithHosts(<ConsentModal api={fake.api} scope={scope} document={issued} readOnly={false} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('발행본을 찾을 수 없습니다');
    expect(screen.getByRole('button', { name: '이 발행본에 손서명 저장' })).toBeDisabled();
  });

  it('입력이 남은 채 닫으면 확인을 받고, 취소하면 유지한다', async () => {
    const { onClose } = await open([]);
    fireEvent.change(screen.getByLabelText('서명자 이름'), { target: { value: '김' } });
    fireEvent.click(screen.getAllByRole('button', { name: '닫기' }).at(-1)!);
    fireEvent.click(within(await screen.findByRole('dialog', { name: '작성 중인 기록' })).getByRole('button', { name: '취소' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('서명자 이름')).toHaveValue('김');
    fireEvent.click(screen.getAllByRole('button', { name: '닫기' }).at(-1)!);
    fireEvent.click(within(await screen.findByRole('dialog', { name: '작성 중인 기록' })).getByRole('button', { name: '버리고 닫기' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
