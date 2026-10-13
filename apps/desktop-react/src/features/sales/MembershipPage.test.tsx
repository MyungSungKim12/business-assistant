import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { apiFailure } from '../appointment-resources/testApi';
import { ORG, bodies, server, type Handlers } from '../catalog/testServer';
import { MembershipPage } from './MembershipPage';

const NOW = new Date('2026-10-13T03:00:00Z');
const wallet = (over: Record<string, unknown> = {}) => ({
  id: 'w1', organization_id: ORG, customer_id: 'c1', customer_name: '김고객', product_id: 'p1', name_snapshot: '10회 패키지', money_balance: '0', count_balance: 4,
  issued_money: '0', issued_count: 10, valid_from: '2026-01-01', expires_on: '2026-12-31', lifecycle_status: 'active', paused_on: null, lifecycle_version: 2,
  created_at: '2026-01-01T00:00:00Z', ...over,
});
/** 수명주기 변경 응답(고객 지갑 스키마)에는 sale_line_id 가 필요하다. */
const saved = (over: Record<string, unknown> = {}) => ({ ...wallet(over), sale_line_id: 'l1' });
const list = 'GET /wallets';
const historyKey = (customer = 'c1', id = 'w1') => `GET /customers/${customer}/wallets/${id}/history`;
const lifecycle = (customer = 'c1', id = 'w1') => `POST /customers/${customer}/wallets/${id}/lifecycle`;
const event = (over: Record<string, unknown> = {}) => ({
  id: 'e1', event_type: 'use', occurred_at: '2026-10-05T01:00:00Z', money_delta: '0', count_delta: -1, reason: null, visit_id: 'v1', previous_expires_on: null, expires_on: null, ...over,
});
const grid = () => within(screen.getByRole('grid', { name: '회원권 목록' }));

function renderPage(handlers: Handlers, readOnly = false) {
  const kit = server({ [historyKey()]: () => [], ...handlers });
  render(<><NoticeHost /><ConfirmDialog /><MembershipPage api={kit.api as never} organizationId={ORG} readOnly={readOnly} /></>);
  return kit;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });
afterEach(() => { vi.useRealTimers(); });

describe('WAL-10 지갑 목록', () => {
  it('고객·회원권·종류·잔액·잔여 횟수·만료일·상태를 보여 준다', async () => {
    renderPage({ [list]: () => [wallet(), wallet({ id: 'w2', customer_name: '이고객', name_snapshot: '금액권', issued_money: '100000', issued_count: 0, money_balance: '30000', count_balance: 0, expires_on: null })] });
    expect(await screen.findByText('김고객')).toBeInTheDocument();
    const row = within(grid().getByText('김고객').closest('tr') as HTMLElement);
    expect(row.getByText('10회 패키지')).toBeInTheDocument();
    expect(row.getByText('횟수권')).toBeInTheDocument();
    expect(row.getByText('4회')).toBeInTheDocument();
    expect(row.getByText('2026-12-31')).toBeInTheDocument();
    expect(row.getByText('사용 가능')).toBeInTheDocument();
    const second = within(grid().getByText('이고객').closest('tr') as HTMLElement);
    expect(second.getAllByText('금액권')).toHaveLength(2);
    expect(second.getByText('30,000원')).toBeInTheDocument();
    expect(second.getByText('기간 제한 없음')).toBeInTheDocument();
  });

  it('30일 이내 만료는 D-n 으로 강조하고 상태 필터에서 모아 본다', async () => {
    renderPage({ [list]: () => [wallet(), wallet({ id: 'w2', customer_name: '임박', expires_on: '2026-10-20' }), wallet({ id: 'w3', customer_name: '지남', expires_on: '2026-10-01' }), wallet({ id: 'w4', customer_name: '멈춤', lifecycle_status: 'paused', paused_on: '2026-10-01' })] });
    await screen.findByText('임박');
    expect(grid().getByText('D-7')).toBeInTheDocument();
    expect(grid().getAllByText(/^D-/)).toHaveLength(1);
    expect(screen.getByText(/30일 이내 만료 1건/)).toBeInTheDocument();
    const filter = screen.getByLabelText('회원권 상태 필터');
    fireEvent.change(filter, { target: { value: 'expiring' } });
    expect(screen.queryByText('김고객')).not.toBeInTheDocument();
    expect(screen.getByText('임박')).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'expired' } });
    expect(screen.getByText('지남')).toBeInTheDocument();
    expect(screen.queryByText('임박')).not.toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'paused' } });
    expect(grid().getByText('멈춤')).toBeInTheDocument();
    expect(screen.queryByText('임박')).not.toBeInTheDocument();
  });

  it('검색은 고객과 회원권 이름에 적용한다', async () => {
    renderPage({ [list]: () => [wallet(), wallet({ id: 'w2', customer_name: '이고객', name_snapshot: '금액권' })] });
    await screen.findByText('이고객');
    fireEvent.change(screen.getByLabelText('회원권 검색'), { target: { value: '금액' } });
    expect(screen.queryByText('김고객')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('회원권 검색'), { target: { value: '없는이름' } });
    expect(screen.getByText('조건에 맞는 회원권이 없습니다.')).toBeInTheDocument();
  });

  it('권한 없음·불러오기 실패를 구분하고 재시도할 수 있다', async () => {
    let status = 403;
    let fail = true;
    renderPage({ [list]: () => { if (fail) throw apiFailure(status); return [wallet()]; } });
    expect(await screen.findByText('회원권을 볼 권한이 없습니다.')).toBeInTheDocument();
    status = 503; fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('김고객')).toBeInTheDocument();
  });

  it('지갑이 없으면 빈 상태를 보여 준다', async () => {
    renderPage({ [list]: () => [] });
    expect(await screen.findByText('표시할 회원권이 없습니다.')).toBeInTheDocument();
  });
});

describe('WAL-10 상세와 잔액 변동 이력', () => {
  it('선택하면 요약과 이력을 불러온다', async () => {
    const history = [
      event(),
      event({ id: 'e2', event_type: 'extend', count_delta: 0, reason: '고객 요청', previous_expires_on: '2026-12-24', expires_on: '2026-12-31', occurred_at: '2026-10-08T01:00:00Z', visit_id: null }),
      event({ id: 'e3', event_type: 'issue', count_delta: 10, occurred_at: '2026-01-01T01:00:00Z', visit_id: null }),
    ];
    const { calls } = renderPage({ [list]: () => [wallet()], [historyKey()]: () => history });
    fireEvent.click(await screen.findByText('김고객'));
    const detail = within(await screen.findByLabelText('회원권 상세'));
    expect(detail.getByText('10회 패키지')).toBeInTheDocument();
    const log = within(await detail.findByRole('grid', { name: '잔액 변동 이력' }));
    expect(log.getByText('발급')).toBeInTheDocument();
    expect(log.getByText('+10회')).toBeInTheDocument();
    expect(log.getByText('-1회')).toBeInTheDocument();
    expect(log.getByText('기간 연장')).toBeInTheDocument();
    expect(log.getByText('만료일 2026-12-24 → 2026-12-31 · 고객 요청')).toBeInTheDocument();
    expect(calls.filter((call) => call.path.endsWith('/history'))).toHaveLength(1);
  });

  it('이력 조회 실패는 상세와 별개로 재시도할 수 있다', async () => {
    let fail = true;
    renderPage({ [list]: () => [wallet()], [historyKey()]: () => { if (fail) throw apiFailure(503); return [event()]; } });
    fireEvent.click(await screen.findByText('김고객'));
    expect(await screen.findByText('이력을 불러오지 못했습니다.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(screen.getByLabelText('회원권 상세')).getByRole('button', { name: '다시 시도' }));
    expect(await within(screen.getByLabelText('회원권 상세')).findByText('-1회')).toBeInTheDocument();
  });
});

describe('WAL-10 정지·재개·연장', () => {
  it('연장은 사유·일수·버전·멱등 키를 보내고 목록을 다시 읽는다', async () => {
    let loads = 0;
    const { calls } = renderPage({ [list]: () => { loads += 1; return [wallet()]; }, [lifecycle()]: () => saved({ lifecycle_version: 3 }) });
    fireEvent.click(await screen.findByText('김고객'));
    fireEvent.click(screen.getByRole('button', { name: '기간 연장' }));
    fireEvent.click(screen.getByRole('button', { name: '기간 연장 확인' }));
    expect(await screen.findByText('변경 사유를 입력하세요.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('연장할 일수'), { target: { value: '14' } });
    fireEvent.change(screen.getByLabelText('변경 사유'), { target: { value: '고객 요청' } });
    fireEvent.click(screen.getByRole('button', { name: '기간 연장 확인' }));
    await waitFor(() => expect(bodies(calls, lifecycle())).toHaveLength(1));
    const [body] = bodies(calls, lifecycle());
    expect(body).toMatchObject({ action: 'extend', extend_days: 14, reason: '고객 요청', expected_version: 2 });
    expect(typeof body.operation_id).toBe('string');
    await waitFor(() => expect(loads).toBe(2));
  });

  it('정지는 확인을 거치고, 정지 상태에서는 재개만 켜진다', async () => {
    const { calls } = renderPage({ [list]: () => [wallet()], [lifecycle()]: () => saved({ lifecycle_status: 'paused', paused_on: '2026-10-13', lifecycle_version: 3 }) });
    fireEvent.click(await screen.findByText('김고객'));
    expect(screen.getByRole('button', { name: '재개' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '정지' }));
    fireEvent.change(screen.getByLabelText('변경 사유'), { target: { value: '여행' } });
    fireEvent.click(screen.getByRole('button', { name: '정지 확인' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/재개하면 정지한 기간만큼 만료일이 늘어납니다/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodies(calls, lifecycle())).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '정지 확인' }));
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: '정지' }));
    await waitFor(() => expect(bodies(calls, lifecycle())).toHaveLength(1));
    expect(bodies(calls, lifecycle())[0]).toMatchObject({ action: 'pause', extend_days: null, reason: '여행', expected_version: 2 });
  });

  it('충돌(409)은 안내하고, 알 수 없는 실패는 같은 operation_id로 재시도한다', async () => {
    let mode: 'conflict' | 'unknown' | 'ok' = 'conflict';
    const { calls } = renderPage({
      [list]: () => [wallet({ lifecycle_status: 'paused', paused_on: '2026-10-01' })],
      [lifecycle()]: () => { if (mode === 'conflict') throw apiFailure(409); if (mode === 'unknown') throw apiFailure(503); return saved(); },
    });
    fireEvent.click(await screen.findByText('김고객'));
    fireEvent.click(screen.getByRole('button', { name: '재개' }));
    fireEvent.change(screen.getByLabelText('변경 사유'), { target: { value: '복귀' } });
    fireEvent.click(screen.getByRole('button', { name: '재개 확인' }));
    expect(await screen.findByText('다른 변경과 충돌했습니다. 목록을 새로고침한 뒤 다시 확인하세요.')).toBeInTheDocument();
    mode = 'unknown';
    fireEvent.click(screen.getByRole('button', { name: '재개 확인' }));
    expect(await screen.findByText(/결과가 불명확합니다/)).toBeInTheDocument();
    mode = 'ok';
    fireEvent.click(screen.getByRole('button', { name: '재개 확인' }));
    await waitFor(() => expect(bodies(calls, lifecycle())).toHaveLength(3));
    const ids = bodies(calls, lifecycle()).map((body) => body.operation_id);
    expect(ids[2]).toBe(ids[1]);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('읽기 전용(member)은 정지·재개·연장 버튼이 없고 이력은 볼 수 있다', async () => {
    renderPage({ [list]: () => [wallet()], [historyKey()]: () => [event()] }, true);
    fireEvent.click(await screen.findByText('김고객'));
    expect(await screen.findByText('-1회')).toBeInTheDocument();
    for (const name of ['정지', '재개', '기간 연장']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '고객 회원권 전체' })).toBeEnabled();
  });

  it('고객 회원권 전체 버튼은 기존 고객 지갑 대화상자를 연다', async () => {
    renderPage({ [list]: () => [wallet()], 'GET /customers/c1/wallets': () => [] });
    fireEvent.click(await screen.findByText('김고객'));
    fireEvent.click(screen.getByRole('button', { name: '고객 회원권 전체' }));
    expect(await screen.findByRole('dialog', { name: '고객 회원권 · 잔여 혜택' })).toBeInTheDocument();
  });
});
