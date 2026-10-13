import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentModal } from './ConsentModal';
import { CUSTOMER, DOCUMENT, fakeApi, httpError, issued, matches, ORG, renderWithHosts, signEvent, TREATMENT, type Call } from './testkit';

const exported = vi.hoisted(() => ({ renderPdf: vi.fn(), savePdf: vi.fn() }));
vi.mock('../../lib/pdf', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/pdf')>()), renderPdf: exported.renderPdf, savePdf: exported.savePdf }));

const eventsPath = /\/documents\/[^/]+\/events$/;
const verifyPath = /\/documents\/[^/]+\/events\/[^/]+\/verify$/;
const scope = { organizationId: ORG, customerId: CUSTOMER, treatmentId: TREATMENT };
const hash = 'ab12cd34'.repeat(8);
const withEvidence = { ...signEvent, evidence: { algorithm: 'sha256-canonical-json-v1', hash } };
const verification = (status: string, extra: object = {}) => ({ event_id: signEvent.id, revision: 1, status, algorithm: 'sha256-canonical-json-v1', stored_hash: hash, computed_hash: hash, occurred_at: signEvent.occurred_at, ...extra });

beforeEach(() => {
  exported.renderPdf.mockReset().mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  exported.savePdf.mockReset().mockResolvedValue(true);
});

async function open(events: unknown[], handler: (call: Call) => unknown = () => undefined, readOnly = false) {
  const fake = fakeApi((call) => {
    const custom = handler(call);
    if (custom !== undefined) return custom;
    if (matches(call, 'GET', eventsPath)) return events;
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  renderWithHosts(<ConsentModal api={fake.api} scope={scope} document={issued} readOnly={readOnly} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('consent-state')).not.toHaveTextContent('확인 중'));
  fireEvent.click(screen.getByRole('tab', { name: '전체 이력' }));
  return fake;
}

describe('서명 증빙 해시 · 무결성 확인', () => {
  it('이력에 증빙 해시 앞 8자리를 보여 주고 증빙이 없던 기록은 없음으로 표시한다', async () => {
    await open([withEvidence, { ...signEvent, id: '99999999-9999-4999-8999-999999999999', revision: 2, action: 'deliver', values: { method: 'paper', recipient: '김고객', reference: '', note: '', confirmed: true } }]);
    expect(screen.getByRole('button', { name: /1\. 현장 손서명.*증빙 ab12cd34/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2\. 교부 확인 기록.*증빙 없음/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /1\. 현장 손서명/ }));
    expect(screen.getByLabelText('기록 상세')).toHaveTextContent('증빙 해시: ab12cd34…');
    expect(screen.getByLabelText('기록 상세')).toHaveTextContent('기록 시각(서버)');
  });

  it('무결성 확인은 서버 verify 경로를 부르고 일치 결과를 보여 준다', async () => {
    const { calls } = await open([withEvidence], (call) => (matches(call, 'GET', verifyPath) ? verification('match') : undefined));
    fireEvent.click(screen.getByRole('button', { name: /1\. 현장 손서명/ }));
    fireEvent.click(screen.getByRole('button', { name: '무결성 확인' }));
    expect(await screen.findByText('일치 · 기록 이후 변경 없음')).toBeInTheDocument();
    const call = calls.find((entry) => matches(entry, 'GET', verifyPath))!;
    expect(call.path).toContain(`/documents/${DOCUMENT}/events/${signEvent.id}/verify`);
  });

  it.each([
    ['mismatch', '불일치 · 기록 내용이 달라졌습니다'],
    ['no_proof', '증빙 해시 없음 · 이전 기록'],
    ['unknown_algorithm', '확인 불가 · 알 수 없는 해시 방식'],
  ])('%s 결과를 구분해 보여 준다', async (status, label) => {
    await open([withEvidence], (call) => (matches(call, 'GET', verifyPath) ? verification(status) : undefined));
    fireEvent.click(screen.getByRole('button', { name: /1\. 현장 손서명/ }));
    fireEvent.click(screen.getByRole('button', { name: '무결성 확인' }));
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('확인에 실패하면 오류를 알리고 다시 시도할 수 있다', async () => {
    let fail = true;
    await open([withEvidence], (call) => {
      if (!matches(call, 'GET', verifyPath)) return undefined;
      if (fail) throw httpError(500);
      return verification('match');
    });
    fireEvent.click(screen.getByRole('button', { name: /1\. 현장 손서명/ }));
    fireEvent.click(screen.getByRole('button', { name: '무결성 확인' }));
    expect(await screen.findByText('무결성을 확인하지 못했습니다. 다시 시도하세요.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '무결성 확인' }));
    expect(await screen.findByText('일치 · 기록 이후 변경 없음')).toBeInTheDocument();
  });

  it('읽기 전용(멤버)도 무결성을 확인할 수 있다', async () => {
    await open([withEvidence], (call) => (matches(call, 'GET', verifyPath) ? verification('match') : undefined), true);
    fireEvent.click(screen.getByRole('button', { name: /1\. 현장 손서명/ }));
    fireEvent.click(screen.getByRole('button', { name: '무결성 확인' }));
    expect(await screen.findByText('일치 · 기록 이후 변경 없음')).toBeInTheDocument();
  });
});

describe('발행본 PDF 저장', () => {
  it('이미 불러온 이력으로 PDF 를 만들어 저장하고 알림을 띄운다(이력을 다시 읽지 않는다)', async () => {
    const { calls } = await open([withEvidence]);
    const reads = calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'PDF 저장' }));
    expect(await screen.findByText('PDF를 저장했습니다.')).toBeInTheDocument();
    expect(exported.renderPdf).toHaveBeenCalledTimes(1);
    const spec = exported.renderPdf.mock.calls[0][0] as { title: string; sections: unknown[] };
    expect(spec.title).toBe(issued.title);
    expect(JSON.stringify(spec.sections)).toContain(hash);
    expect(exported.savePdf).toHaveBeenCalledWith(`${issued.title}_발행본`, expect.any(Uint8Array));
    expect(calls).toHaveLength(reads);
  });

  it('저장 대화상자를 취소하면 성공 알림을 띄우지 않는다', async () => {
    exported.savePdf.mockResolvedValue(false);
    await open([withEvidence]);
    // 알림 저장소는 모듈 전역이라 앞선 테스트의 알림이 남아 있을 수 있다. 개수가 늘지 않는지로 확인한다.
    const before = screen.queryAllByText('PDF를 저장했습니다.').length;
    fireEvent.click(screen.getByRole('button', { name: 'PDF 저장' }));
    await waitFor(() => expect(exported.savePdf).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'PDF 저장' })).toBeEnabled());
    expect(screen.queryAllByText('PDF를 저장했습니다.')).toHaveLength(before);
  });

  it('PDF 생성이 실패하면 오류 알림을 띄우고 버튼을 다시 쓸 수 있다', async () => {
    exported.renderPdf.mockRejectedValue(new Error('글꼴을 불러오지 못했습니다.'));
    await open([withEvidence]);
    fireEvent.click(screen.getByRole('button', { name: 'PDF 저장' }));
    expect(await screen.findByText(/PDF를 만들지 못했습니다\. 글꼴을 불러오지 못했습니다\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PDF 저장' })).toBeEnabled();
  });
});
