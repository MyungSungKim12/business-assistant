import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { SalesPage } from './SalesPage';
import { CART, CUSTOMER, CUSTOMER2, ORG, VISIT, bundle, fakeApi, uid, visit, type Call } from './testkit';

const exported = vi.hoisted(() => ({ calls: [] as Array<{ title: string; format: string; rows: unknown[] }> }));
vi.mock('../../lib/io/exportTable', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/io/exportTable')>();
  return { ...original, exportTable: vi.fn(async (options: { title: string; format: string; rows: unknown[] }) => { exported.calls.push(options); return true; }) };
});

const entry = (n: number, over: Record<string, unknown> = {}) => ({
  id: uid(n), kind: 'payment', method: 'card', amount: '60000', occurred_at: `2030-01-${String(10 + n).padStart(2, '0')}T02:00:00Z`, reference: `A-${n}`, reason: '',
  cart_id: CART, visit_id: VISIT, customer_id: CUSTOMER, customer_name: '김고객', ...over,
});
const totals = (over: Record<string, unknown> = {}) => ({ payment_total: '120000', refund_total: '10000', net_total: '110000', payment_count: 2, refund_count: 1, row_count: 3, ...over });
const page = (rows: unknown[], next: string | null = null, over: Record<string, unknown> = {}) => ({ rows, next_cursor: next, totals: totals(over) });

const defaults = (): Record<string, (body: unknown, call: Call) => unknown> => ({
  'GET /visits': () => [visit()],
  'GET /sale-cart-drafts': () => [],
  'GET /visits/:id/sale-cart': () => bundle(),
  'GET /sale-payments': () => page([
    entry(1), entry(2, { method: 'cash', amount: '60000', reference: '' }),
    entry(3, { kind: 'refund', amount: '10000', reference: '', reason: '단순 변심', customer_id: CUSTOMER2, customer_name: '이고객' }),
  ]),
});

async function openHistory(handlers: Record<string, (body: unknown, call: Call) => unknown> = {}) {
  const kit = fakeApi({ ...defaults(), ...handlers });
  const user = userEvent.setup();
  render(<><SalesPage api={kit.api} organizationId={ORG} readOnly={false} /><ConfirmDialog /><NoticeHost /></>);
  await screen.findByRole('heading', { name: '방문 결제 장바구니' });
  await user.click(screen.getByRole('tab', { name: '매출 내역' }));
  return { ...kit, user };
}
const historyCalls = (calls: Call[]) => calls.filter((call) => call.path.startsWith('/sale-payments')).map((call) => call.path);

describe('매출 내역 탭', () => {
  beforeEach(() => { window.localStorage.clear(); exported.calls.length = 0; });

  it('처음에는 장바구니 탭이고 매출 내역은 탭을 열 때에만 불러온다', async () => {
    const kit = fakeApi(defaults());
    render(<SalesPage api={kit.api} organizationId={ORG} readOnly={false} />);
    await screen.findByRole('heading', { name: '방문 결제 장바구니' });
    expect(screen.getByRole('tab', { name: '장바구니' })).toHaveAttribute('aria-selected', 'true');
    expect(historyCalls(kit.calls)).toEqual([]);
  });

  it('수납·환불 내역과 합계를 보여 주고 기본 조건(최신순 50건)으로 조회한다', async () => {
    const { calls } = await openHistory();
    expect(await screen.findByText('A-1')).toBeInTheDocument();
    expect(historyCalls(calls)).toEqual(['/sale-payments?sort=newest&limit=50']);
    const cards = screen.getByTestId('history-totals');
    expect(cards).toHaveTextContent('수납 120,000원 (2건)');
    expect(cards).toHaveTextContent('환불·반품 10,000원 (1건)');
    expect(cards).toHaveTextContent('순매출 110,000원');
    const table = screen.getByRole('table', { name: '수납·환불·반품 내역' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('단순 변심')).toBeInTheDocument();
    expect(within(table).getByText('-10,000원')).toBeInTheDocument();
    expect(screen.getByTestId('history-count')).toHaveTextContent('3건 표시 / 조건에 맞는 전체 3건');
  });

  it('일자·고객·수단·유형·금액 조건을 서버에 전달한다', async () => {
    const { user, calls } = await openHistory();
    await screen.findByText('A-1');
    await user.type(screen.getByLabelText('시작일'), '2030-01-01');
    await user.type(screen.getByLabelText('종료일'), '2030-01-31');
    await user.selectOptions(screen.getByLabelText('고객 조건'), CUSTOMER2);
    await user.selectOptions(screen.getByLabelText('수단'), 'cash');
    await user.selectOptions(screen.getByLabelText('유형'), 'refund');
    await user.type(screen.getByLabelText('최소 금액'), '1,000');
    await user.type(screen.getByLabelText('최대 금액'), '50000');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(historyCalls(calls).at(-1)).toBe(
      `/sale-payments?from_date=2030-01-01&to_date=2030-01-31&customer_id=${CUSTOMER2}&method=cash&kind=refund&min_amount=1000&max_amount=50000&sort=newest&limit=50`,
    ));
  });

  it('잘못된 조건은 요청하지 않고 안내하며, 초기화하면 조건 없이 다시 조회한다', async () => {
    const { user, calls } = await openHistory();
    await screen.findByText('A-1');
    const before = historyCalls(calls).length;
    await user.type(screen.getByLabelText('최소 금액'), '500');
    await user.type(screen.getByLabelText('최대 금액'), '100');
    await user.click(screen.getByRole('button', { name: '검색' }));
    expect(await screen.findByText('최소 금액은 최대 금액보다 클 수 없습니다.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('최대 금액'));
    await user.type(screen.getByLabelText('최대 금액'), 'x');
    await user.click(screen.getByRole('button', { name: '검색' }));
    expect(await screen.findByText('금액은 0 이상의 원 단위 정수로 입력하세요.')).toBeInTheDocument();
    expect(historyCalls(calls)).toHaveLength(before);
    await user.click(screen.getByRole('button', { name: '조건 초기화' }));
    expect(screen.getByLabelText('최소 금액')).toHaveValue('');
    expect(screen.queryByText('금액은 0 이상의 원 단위 정수로 입력하세요.')).not.toBeInTheDocument();
  });

  it('더 보기는 다음 커서로 이어 받고 중복 행을 합치며 끝나면 버튼이 사라진다', async () => {
    let call = 0;
    const { user, calls } = await openHistory({
      'GET /sale-payments': () => { call += 1; return call === 1 ? page([entry(1), entry(2)], 'cursor-1', { row_count: 3 }) : page([entry(2), entry(3)], null, { row_count: 3 }); },
    });
    await screen.findByText('A-1');
    expect(screen.getByTestId('history-count')).toHaveTextContent('2건 표시 / 조건에 맞는 전체 3건');
    await user.click(screen.getByRole('button', { name: '더 보기' }));
    await screen.findByText('A-3');
    expect(historyCalls(calls).at(-1)).toBe('/sale-payments?sort=newest&cursor=cursor-1&limit=50');
    expect(screen.getByTestId('history-count')).toHaveTextContent('3건 표시');
    expect(screen.queryByRole('button', { name: '더 보기' })).not.toBeInTheDocument();
  });

  it('일시 열은 서버 정렬(최신↔오래된 순), 금액 열은 불러온 행 안에서 정렬한다', async () => {
    const { user, calls } = await openHistory({
      'GET /sale-payments': () => page([entry(1, { amount: '30000' }), entry(2, { amount: '90000' }), entry(3, { amount: '10000' })], 'more', { row_count: 9 }),
    });
    await screen.findByText('A-1');
    const amountOrder = () => within(screen.getByRole('table')).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[4].textContent);
    await user.click(screen.getByRole('button', { name: '금액' }));
    expect(amountOrder()).toEqual(['90,000원', '30,000원', '10,000원']);
    expect(screen.getByTestId('history-count')).toHaveTextContent('시각 외 열 정렬은 표시된 건 기준입니다.');
    await user.click(screen.getByRole('button', { name: /^금액/ }));
    expect(amountOrder()).toEqual(['10,000원', '30,000원', '90,000원']);
    await user.click(screen.getByRole('button', { name: '일시' }));
    await user.click(screen.getByRole('button', { name: /^일시/ }));
    await waitFor(() => expect(historyCalls(calls).at(-1)).toBe('/sale-payments?sort=oldest&limit=50'));
  });

  it('행의 장바구니 버튼은 해당 방문의 장바구니 탭을 연다', async () => {
    const { user, calls } = await openHistory();
    await screen.findByText('A-1');
    await user.click(screen.getAllByRole('button', { name: '방문 장바구니 열기 김고객' })[0]);
    expect(screen.getByRole('tab', { name: '장바구니' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(calls.some((call) => call.path === `/visits/${VISIT}/sale-cart`)).toBe(true));
    expect(await screen.findByText(/장바구니 상태: 작성 중/)).toBeInTheDocument();
  });

  it('조회 실패는 안내와 재시도를 보여 주고 권한 오류는 별도 문구를 쓴다', async () => {
    let fail = true;
    const { user } = await openHistory({ 'GET /sale-payments': () => (fail ? new ApiError(503, 'HTTP_503', 'x', true) : page([entry(1)])) });
    expect(await screen.findByText(/매출 내역을 불러오지 못했습니다/)).toBeInTheDocument();
    expect(screen.queryByTestId('history-totals')).not.toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('A-1')).toBeInTheDocument();
  });

  it('권한이 없으면(403) 권한 안내를 보여 준다', async () => {
    await openHistory({ 'GET /sale-payments': () => new ApiError(403, 'HTTP_403', 'denied', false) });
    expect(await screen.findByText('매출 내역을 볼 권한이 없습니다.')).toBeInTheDocument();
  });

  it('내보내기는 화면 쪽수와 무관하게 조건에 맞는 전체 행을 모아 저장한다', async () => {
    const { user, calls } = await openHistory({
      'GET /sale-payments': (_body, call) => (call.path.includes('cursor=c1')
        ? page([entry(3)], null, { row_count: 3 })
        : call.path.includes('limit=200') ? page([entry(1), entry(2)], 'c1', { row_count: 3 }) : page([entry(1)], 'c1', { row_count: 3 })),
    });
    await screen.findByText('A-1');
    await user.click(screen.getByRole('button', { name: '내보내기' }));
    expect(await screen.findByText(/전체 3건\(화면에 표시된 쪽수와 무관\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'CSV (.csv)' }));
    await waitFor(() => expect(exported.calls).toHaveLength(1));
    expect(exported.calls[0]).toMatchObject({ title: '매출 내역', format: 'csv' });
    expect(exported.calls[0].rows.map((row) => (row as { id: string }).id)).toEqual([uid(1), uid(2), uid(3)]);
    expect(historyCalls(calls).slice(-2)).toEqual(['/sale-payments?sort=newest&limit=200', '/sale-payments?sort=newest&cursor=c1&limit=200']);
  });

  it('조건에 맞는 내역이 너무 많으면 내보내지 않고 조건을 좁히라고 안내한다', async () => {
    const { user } = await openHistory({ 'GET /sale-payments': () => page([entry(1)], 'c1', { row_count: 20_001 }) });
    await screen.findByText('A-1');
    await user.click(screen.getByRole('button', { name: '내보내기' }));
    await user.click(screen.getByRole('button', { name: '엑셀 (.xlsx)' }));
    expect(await screen.findByText(/너무 많습니다/)).toBeInTheDocument();
    expect(exported.calls).toHaveLength(0);
  });
});
