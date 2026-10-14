import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import type { DashboardApi } from './dashboardApi';
import { DashboardPage } from './DashboardPage';

const NOW = new Date('2026-10-13T01:00:00Z'); // KST 2026-10-13 10:00 (화)
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const customers = [
  { id: id(1), name: '김하나', phone: '010-1111', status: 'active', next_visit_date: '2026-10-15', last_visit_date: '2026-10-10' },
  { id: id(2), name: '이둘', phone: null, status: 'active', next_visit_date: '2026-10-30', last_visit_date: '2026-10-12' },
  { id: id(3), name: '보관됨', phone: null, status: 'archived', next_visit_date: '2026-10-14', last_visit_date: null },
];
const tasks = [
  { id: id(11), title: '지난 업무', status: 'open', priority: 'high', due_at: '2026-10-11T03:00:00Z' },
  { id: id(12), title: '오늘 업무', status: 'in_progress', priority: 'normal', due_at: '2026-10-13T05:00:00Z' },
  { id: id(13), title: '이번 주 업무', status: 'open', priority: 'low', due_at: '2026-10-16T05:00:00Z' },
  { id: id(14), title: '끝난 업무', status: 'done', priority: 'low', due_at: '2026-10-13T05:00:00Z' },
];
const appointments = [
  { id: id(21), customer_id: id(1), staff_id: id(31), service_id: id(41), service_name_snapshot: '페이셜', start_at: '2026-10-13T00:30:00Z', status: 'confirmed' },
  { id: id(22), customer_id: id(2), staff_id: id(31), service_id: id(41), service_name_snapshot: '왁싱', start_at: '2026-10-13T05:00:00Z', status: 'completed' },
  { id: id(23), customer_id: id(2), staff_id: id(31), service_id: id(41), service_name_snapshot: '내일 예약', start_at: '2026-10-14T01:00:00Z', status: 'reserved' },
];
const transactions = [
  { id: id(51), transaction_type: 'income', amount: '300000', transaction_date: '2026-10-12', is_archived: false },
  { id: id(52), transaction_type: 'expense', amount: '120000', transaction_date: '2026-10-13', is_archived: false },
];
const receivables = { receivable_count: 1, total_due: '45000', items: [] };
const products = [
  { id: id(61), name: '앰플', kind: 'product', is_active: true, stock_quantity: 2, unit_name: '개' },
  { id: id(62), name: '충분한 상품', kind: 'product', is_active: true, stock_quantity: 50 },
];
const wallets = [{ id: id(71), customer_id: id(1), name_snapshot: '10회권', expires_on: '2026-10-20', count_balance: 4 }];

interface Overrides {
  customers?: () => unknown;
  tasks?: () => unknown;
  appointments?: () => unknown;
  transactions?: () => unknown;
  receivables?: () => unknown;
  products?: () => unknown;
  wallets?: () => unknown;
}

function makeApi(overrides: Overrides = {}) {
  const pick = (key: keyof Overrides, data: unknown) => async () => (overrides[key] ? overrides[key]!() : data);
  const handlers = {
    customers: vi.fn(pick('customers', customers)),
    tasks: vi.fn(pick('tasks', tasks)),
    appointments: vi.fn(pick('appointments', appointments)),
    transactions: vi.fn(pick('transactions', transactions)),
    receivables: vi.fn(pick('receivables', receivables)),
    products: vi.fn(pick('products', products)),
    wallets: vi.fn(pick('wallets', wallets)),
  };
  const api = {
    listCustomers: () => handlers.customers(),
    listTasks: () => handlers.tasks(),
    listAppointmentStaff: async () => [{ id: id(31), name: '박실장', is_active: true }],
    listAppointmentServices: async () => [],
    listOperationRecords: () => handlers.wallets(),
    call: async (_method: string, path: string) => {
      if (path.includes('/appointments?')) return handlers.appointments();
      if (path.includes('/finance-transactions')) return handlers.transactions();
      if (path.includes('/receivables')) return handlers.receivables();
      if (path.includes('/catalog-products')) return handlers.products();
      throw new Error(`unexpected ${path}`);
    },
  } as unknown as DashboardApi;
  return { api, handlers };
}

const forbidden = () => { throw new ApiError(403, 'FORBIDDEN', 'no', false); };
const unavailable = () => { throw new ApiError(503, 'UNAVAILABLE', 'no', true); };

function renderPage(api: DashboardApi, extra: Partial<Parameters<typeof DashboardPage>[0]> = {}) {
  const onNavigate = vi.fn();
  render(<DashboardPage api={api} organizationId="org" organizationName="LCID 매장" now={() => NOW} onNavigate={onNavigate} {...extra} />);
  return onNavigate;
}

const panel = (name: string | RegExp) => screen.getByRole('region', { name });
const panelNames = [/^오늘 예약$/, /^할 일$/, /수입·지출/, /다음 방문 임박/, /^최근 방문 고객$/, /^재고 부족$/, /회원권 만료/];

describe('DashboardPage', () => {
  it('매장명과 KST 오늘 날짜를 보여 주고 지표 카드를 계산한다', async () => {
    const { api } = makeApi();
    renderPage(api);
    expect(screen.getByRole('heading', { name: 'LCID 매장' })).toBeInTheDocument();
    expect(screen.getByText('2026년 10월 13일 (화)')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^전체 고객 2명/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^오늘 예약 2건 미완료 1 · 완료 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^미완료 할 일 3건 기한 지남 1 · 오늘 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^이번 달 순수입 180,000원 수입 300,000원 · 지출 120,000원/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^전체 미수금 45,000원 미수 1건/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^재고 부족 상품 1개/ })).toBeInTheDocument();
  });

  it('패널에 오늘 예약 타임라인, 할 일, 고객, 재고, 회원권, 차트를 채운다', async () => {
    const { api } = makeApi();
    renderPage(api);
    const timeline = panel(/^오늘 예약$/);
    expect(await within(timeline).findByText('김하나')).toBeInTheDocument();
    const rows = within(timeline).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('09:30');
    expect(rows[0]).toHaveTextContent('페이셜 · 박실장');
    expect(rows[0]).toHaveTextContent('확정');
    expect(rows[1]).toHaveTextContent('완료');
    expect(within(timeline).queryByText('내일 예약')).toBeNull();
    const taskPanel = panel(/^할 일$/);
    expect(await within(taskPanel).findByText('지난 업무')).toBeInTheDocument();
    expect(within(taskPanel).getByText('오늘 업무')).toBeInTheDocument();
    expect(within(taskPanel).getByText('이번 주 업무')).toBeInTheDocument();
    expect(within(taskPanel).queryByText('끝난 업무')).toBeNull();
    expect(await within(panel(/다음 방문 임박/)).findByText('김하나')).toBeInTheDocument();
    expect(within(panel(/다음 방문 임박/)).queryByText('이둘')).toBeNull();
    expect(within(panel(/^최근 방문 고객$/)).getByText('이둘')).toBeInTheDocument();
    expect(await within(panel(/^재고 부족$/)).findByText('앰플')).toBeInTheDocument();
    expect(within(panel(/회원권 만료/)).getByText('10회권')).toBeInTheDocument();
    const chart = await within(panel(/수입·지출/)).findByRole('img');
    expect(chart).toHaveAccessibleName('최근 14일 수입 합계 300,000원, 지출 합계 120,000원');
  });

  it('카드와 행을 누르면 해당 메뉴로 이동한다', async () => {
    const { api } = makeApi();
    const onNavigate = renderPage(api);
    fireEvent.click(await screen.findByRole('button', { name: /^전체 고객/ }));
    expect(onNavigate).toHaveBeenLastCalledWith('customers');
    fireEvent.click(screen.getByRole('button', { name: /^오늘 예약/ }));
    expect(onNavigate).toHaveBeenLastCalledWith('appointments');
    fireEvent.click(screen.getByRole('button', { name: /^미완료 할 일/ }));
    expect(onNavigate).toHaveBeenLastCalledWith('tasks');
    fireEvent.click(screen.getByRole('button', { name: /^이번 달 순수입/ }));
    expect(onNavigate).toHaveBeenLastCalledWith('finance');
    fireEvent.click(screen.getByRole('button', { name: /^전체 미수금/ }));
    expect(onNavigate).toHaveBeenLastCalledWith('sales');
    fireEvent.click(screen.getByRole('button', { name: /^재고 부족 상품/ }));
    expect(onNavigate).toHaveBeenLastCalledWith('inventory');
    fireEvent.click(await within(panel(/^오늘 예약$/)).findByText('김하나'));
    expect(onNavigate).toHaveBeenLastCalledWith('appointments');
    fireEvent.click(await within(panel(/^할 일$/)).findByText('지난 업무'));
    expect(onNavigate).toHaveBeenLastCalledWith('tasks');
    fireEvent.click(await within(panel(/회원권 만료/)).findByText('10회권'));
    expect(onNavigate).toHaveBeenLastCalledWith('memberships');
  });

  it('한 API가 실패해도 다른 패널은 정상이고 권한 없음/미사용 기능을 구분한다', async () => {
    const { api } = makeApi({ tasks: forbidden, products: unavailable, wallets: () => { throw new Error('boom'); } });
    renderPage(api);
    const taskPanel = panel(/^할 일$/);
    expect(await within(taskPanel).findByText('권한 없음')).toBeInTheDocument();
    expect(await within(panel(/^재고 부족$/)).findByText('미사용 기능')).toBeInTheDocument();
    expect(await within(panel(/회원권 만료/)).findByText('불러오기 실패')).toBeInTheDocument();
    expect(await within(panel(/^오늘 예약$/)).findByText('김하나')).toBeInTheDocument();
    expect(await within(panel(/수입·지출/)).findByRole('img')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^미완료 할 일 - 권한 없음/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^전체 고객 2명/ })).toBeInTheDocument();
  });

  it('실패한 패널만 다시 시도한다', async () => {
    let fail = true;
    const { api, handlers } = makeApi({ tasks: () => { if (fail) throw new ApiError(500, 'X', 'x', true); return tasks; } });
    renderPage(api);
    const taskPanel = panel(/^할 일$/);
    await within(taskPanel).findByText('불러오기 실패');
    const customerCalls = handlers.customers.mock.calls.length;
    fail = false;
    fireEvent.click(within(taskPanel).getByRole('button', { name: '다시 시도' }));
    expect(await within(taskPanel).findByText('지난 업무')).toBeInTheDocument();
    expect(handlers.tasks).toHaveBeenCalledTimes(2);
    expect(handlers.customers.mock.calls.length).toBe(customerCalls);
  });

  it('새로고침은 모든 원본을 다시 불러온다', async () => {
    const { api, handlers } = makeApi();
    renderPage(api);
    await screen.findByRole('button', { name: /^전체 고객 2명/ });
    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(handlers.customers).toHaveBeenCalledTimes(2));
    expect(handlers.tasks).toHaveBeenCalledTimes(2);
    expect(handlers.transactions).toHaveBeenCalledTimes(2);
    expect(handlers.wallets).toHaveBeenCalledTimes(2);
  });

  it('로딩 중에도 모든 패널 틀이 보인다', () => {
    const pending = () => new Promise<never>(() => undefined);
    const { api } = makeApi({ customers: pending, tasks: pending, appointments: pending, transactions: pending, receivables: pending, products: pending, wallets: pending });
    renderPage(api);
    for (const name of panelNames) expect(panel(name)).toBeInTheDocument();
    expect(screen.getAllByText('불러오는 중…').length).toBeGreaterThanOrEqual(panelNames.length);
    expect(screen.getAllByRole('button', { name: /^(전체 고객|오늘 예약|미완료 할 일|이번 달 순수입|전체 미수금|재고 부족 상품)/ })).toHaveLength(6);
  });

  it('데이터가 0건이어도 모든 패널 틀과 빈 안내를 보여 준다', async () => {
    const { api } = makeApi({
      customers: () => [], tasks: () => [], appointments: () => [], transactions: () => [], receivables: () => ({ receivable_count: 0, total_due: '0', items: [] }), products: () => [], wallets: () => [],
    });
    const onNavigate = renderPage(api);
    for (const name of panelNames) expect(panel(name)).toBeInTheDocument();
    const timeline = panel(/^오늘 예약$/);
    expect(await within(timeline).findByText('오늘 예약이 없습니다.')).toBeInTheDocument();
    fireEvent.click(within(timeline).getByRole('button', { name: '새 예약' }));
    expect(onNavigate).toHaveBeenLastCalledWith('appointments');
    expect(await within(panel(/^할 일$/)).findByText('처리할 할 일이 없습니다.')).toBeInTheDocument();
    expect(await within(panel(/^재고 부족$/)).findByText(/인 상품이 없습니다/)).toBeInTheDocument();
    const chartPanel = panel(/수입·지출/);
    expect(await within(chartPanel).findByRole('img')).toBeInTheDocument();
    expect(within(chartPanel).getByText(/기록된 수입·지출이 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^전체 고객 0명/ })).toBeInTheDocument();
  });

  it('빠른 실행: 쓰기 가능하면 모두 보이고 클릭하면 이동한다', () => {
    const { api } = makeApi();
    const onNavigate = renderPage(api, { canManage: true });
    const actions = screen.getByRole('navigation', { name: '빠른 실행' });
    for (const label of ['새 예약', '새 고객', '새 할 일', '새 방문(매출)', '시술 기록', '경영 보기']) {
      expect(within(actions).getByRole('button', { name: label })).toBeInTheDocument();
    }
    fireEvent.click(within(actions).getByRole('button', { name: '새 방문(매출)' }));
    expect(onNavigate).toHaveBeenLastCalledWith('sales');
    fireEvent.click(within(actions).getByRole('button', { name: '새 고객' }));
    expect(onNavigate).toHaveBeenLastCalledWith('customers');
  });

  it('읽기 전용에서는 쓰기 메뉴 바로가기를 숨기고 경영은 관리자에게만 보인다', () => {
    const { api } = makeApi();
    renderPage(api, { readOnly: true });
    const actions = screen.getByRole('navigation', { name: '빠른 실행' });
    expect(within(actions).getByRole('button', { name: '새 예약' })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: '새 할 일' })).toBeInTheDocument();
    for (const label of ['새 고객', '새 방문(매출)', '시술 기록', '경영 보기']) {
      expect(within(actions).queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('미수금 카드는 오늘이 아닌 조직 전체 미수 건수·합계를 서버 요약으로 보여 준다', async () => {
    const paths: string[] = [];
    const { api } = makeApi({ receivables: () => ({ receivable_count: 3, total_due: '1250000', items: [] }) });
    const base = api.call.bind(api);
    (api as { call: typeof api.call }).call = ((method: string, path: string, schema: never, body?: unknown) => { paths.push(path); return base(method as never, path, schema, body as never); }) as typeof api.call;
    renderPage(api);
    expect(await screen.findByRole('button', { name: /^전체 미수금 1,250,000원 미수 3건/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^오늘 미수금/ })).toBeNull();
    expect(paths.some((path) => path.endsWith('/receivables?limit=5'))).toBe(true);
    expect(paths.some((path) => path.includes('/sale-daily-settlement'))).toBe(false);
  });

  it('재고 부족은 상품별 안전재고를 쓰고 값이 없으면 기본 5개를 쓴다', async () => {
    const stock = [
      { id: id(81), name: '기본 기준 상품', kind: 'product', is_active: true, stock_quantity: 5 },
      { id: id(82), name: '높은 기준 상품', kind: 'product', is_active: true, stock_quantity: 9, low_stock_threshold: 10 },
      { id: id(83), name: '널 기준 상품', kind: 'product', is_active: true, stock_quantity: 6, low_stock_threshold: null },
      { id: id(84), name: '낮은 기준 상품', kind: 'product', is_active: true, stock_quantity: 3, low_stock_threshold: 2 },
    ];
    const { api } = makeApi({ products: () => stock });
    renderPage(api);
    expect(await screen.findByRole('button', { name: /^재고 부족 상품 2개/ })).toBeInTheDocument();
    const stockPanel = panel(/^재고 부족$/);
    expect(await within(stockPanel).findByText('기본 기준 상품')).toBeInTheDocument();
    expect(within(stockPanel).getByText('높은 기준 상품')).toBeInTheDocument();
    expect(within(stockPanel).queryByText('널 기준 상품')).toBeNull();
    expect(within(stockPanel).queryByText('낮은 기준 상품')).toBeNull();
    expect(within(stockPanel).getByText('안전재고 10개')).toBeInTheDocument();
    expect(within(stockPanel).getByText('안전재고 5개 (기본)')).toBeInTheDocument();
  });
});

describe('DashboardPage 홈 확장(HOME-03)', () => {
  it('이번 달 순수입 카드에 전월 동기 대비 변화를 보인다', async () => {
    const prior = [...transactions, { id: id(53), transaction_type: 'income', amount: '120000', transaction_date: '2026-09-05', is_archived: false }];
    const { api } = makeApi({ transactions: () => prior });
    renderPage(api);
    expect(await screen.findByRole('button', { name: /^이번 달 순수입 180,000원 .*전월 동기 대비 ▲ 50%$/ })).toBeInTheDocument();
  });

  it('전월 기록이 없으면 비율 대신 안내한다', async () => {
    const { api } = makeApi();
    renderPage(api);
    expect(await screen.findByRole('button', { name: /^이번 달 순수입 .*전월 동기 기록 없음$/ })).toBeInTheDocument();
  });

  it('차트 기간을 고르면 제목·요약이 바뀌고 설정으로 기억한다', async () => {
    const { api } = makeApi();
    renderPage(api);
    const chartPanel = await screen.findByRole('region', { name: /최근 14일 수입·지출/ });
    fireEvent.click(within(chartPanel).getByRole('button', { name: '30일' }));
    const updated = await screen.findByRole('region', { name: /최근 30일 수입·지출/ });
    expect(within(updated).getByRole('img')).toHaveAccessibleName('최근 30일 수입 합계 300,000원, 지출 합계 120,000원');
    expect(within(updated).getByRole('button', { name: '30일' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(updated).getByRole('button', { name: '7일' }));
    expect(await screen.findByRole('region', { name: /최근 7일 수입·지출/ })).toBeInTheDocument();
  });

  it('권한이 있으면 할 일을 홈에서 바로 완료하고 목록을 다시 읽는다', async () => {
    const { api, handlers } = makeApi();
    const updateTask = vi.fn(async () => ({}));
    renderPage({ ...api, updateTask } as unknown as DashboardApi);
    fireEvent.click(await screen.findByRole('button', { name: '지난 업무 완료' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith('org', id(11), { status: 'done' }));
    await waitFor(() => expect(handlers.tasks).toHaveBeenCalledTimes(2));
  });

  it('조회 전용 구성원은 자기에게 지정된 할 일만 완료 버튼이 보인다', async () => {
    const mine = '99999999-9999-4999-8999-999999999999';
    const assigned = tasks.map((task) => (task.id === id(12) ? { ...task, assignee_id: mine } : task));
    const { api } = makeApi({ tasks: () => assigned });
    renderPage({ ...api, updateTask: vi.fn() } as unknown as DashboardApi, { readOnly: true, currentUserId: mine });
    expect(await screen.findByRole('button', { name: '오늘 업무 완료' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '지난 업무 완료' })).not.toBeInTheDocument();
  });

  it('완료에 실패해도 목록은 그대로 두고 오류를 알린다', async () => {
    const { api, handlers } = makeApi();
    const updateTask = vi.fn(async () => { throw new Error('x'); });
    renderPage({ ...api, updateTask } as unknown as DashboardApi);
    fireEvent.click(await screen.findByRole('button', { name: '지난 업무 완료' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalled());
    expect(handlers.tasks).toHaveBeenCalledTimes(1);
  });
});
