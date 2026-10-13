import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { CustomerPage } from './CustomerPage';

const org = '22222222-2222-4222-8222-222222222222';
const make = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, organization_id: org, name: `고객${String(n).padStart(4, '0')}`, email: null, phone: null, notes: '', birth_date: null, skin_type: null,
  concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active', created_at: '2026-10-01T00:00:00Z', ...extra,
});

type Handler = (method: string, url: URL, body?: unknown) => unknown;

function client(handler: Handler, extra: Record<string, unknown> = {}) {
  const call = vi.fn(async (method: string, path: string, _schema: unknown, body?: unknown) => handler(method, new URL(path, 'http://local'), body));
  return {
    api: {
      call, listCustomers: vi.fn(async () => []), listCustomerActivities: vi.fn(async () => []), listCustomerPhotos: vi.fn(async () => []),
      updateCustomer: vi.fn(async (_o: string, id: string, patch: object) => ({ ...make(1), id, ...patch })),
      archiveCustomer: vi.fn(), createCustomer: vi.fn(), ...extra,
    } as unknown as ApiClient,
    call,
  };
}
const searchCalls = (call: ReturnType<typeof vi.fn>) => call.mock.calls.filter((entry) => String(entry[1]).includes('/customers/search')).map((entry) => new URL(String(entry[1]), 'http://local').searchParams);
const renderPage = (api: ApiClient, readOnly = false) => render(<><CustomerPage api={api} organizationId={org} readOnly={readOnly} /><ConfirmDialog /></>);
const grid = () => within(screen.getByRole('grid', { name: '고객 목록' }));

describe('CustomerPage 목록 불러오기', () => {
  it('고객이 적으면 서버 검색 한 번으로 전체를 받고 예전 전체 목록 호출은 하지 않는다', async () => {
    const rows = [make(1), make(2)];
    const { api, call } = client((_m, url) => (url.pathname.endsWith('/customers/search') ? { items: rows, total: 2, next_cursor: null } : []));
    renderPage(api);
    expect(await grid().findByText('고객0001')).toBeInTheDocument();
    expect(api.listCustomers).not.toHaveBeenCalled();
    expect(searchCalls(call)).toHaveLength(1);
    expect(searchCalls(call)[0]!.get('status')).toBe('all');
    expect(screen.getByText('2명')).toBeInTheDocument();
  });

  it('총 건수가 중간(200 초과, 1000 이하)이면 예전처럼 전체 목록을 받아 화면에서 거른다', async () => {
    const all = Array.from({ length: 300 }, (_v, index) => make(index + 1));
    const { api, call } = client((_m, url) => (url.pathname.endsWith('/customers/search') ? { items: all.slice(0, 200), total: 300, next_cursor: 'c' } : []), { listCustomers: vi.fn(async () => all) });
    renderPage(api);
    await grid().findByText('고객0001');
    expect(api.listCustomers).toHaveBeenCalledTimes(1);
    expect(searchCalls(call)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '더 보기' })).not.toBeInTheDocument();
    expect(screen.getByText('300명')).toBeInTheDocument();
  });

  it('고객이 많으면 서버에서 나눠 받고 더 보기로 이어 붙이며 검색어는 서버로 보낸다', async () => {
    const handler: Handler = (_m, url) => {
      if (!url.pathname.endsWith('/customers/search')) return [];
      const q = url.searchParams.get('q');
      const cursor = url.searchParams.get('cursor');
      if (q) return { items: [make(777, { name: '검색됨' })], total: 1, next_cursor: null };
      if (cursor) return { items: [make(3), make(4)], total: 1500, next_cursor: null };
      return { items: [make(1), make(2)], total: 1500, next_cursor: 'next' };
    };
    const { api, call } = client(handler);
    renderPage(api);
    await grid().findByText('고객0001');
    expect(api.listCustomers).not.toHaveBeenCalled();
    expect(screen.getByText('2 / 1500명')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '고객 현황' })).toHaveTextContent('불러온 2명 기준');
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    await grid().findByText('고객0004');
    expect(searchCalls(call).at(-1)!.get('cursor')).toBe('next');
    expect(screen.getByRole('button', { name: '모두 불러옴' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('고객 검색'), { target: { value: '검색' } });
    await grid().findByText('검색됨', undefined, { timeout: 3000 });
    expect(searchCalls(call).at(-1)!.get('q')).toBe('검색');
    expect(grid().queryByText('고객0001')).not.toBeInTheDocument();
  });

  it('서버 검색을 지원하지 않으면 예전 전체 목록으로 대체한다', async () => {
    const { api } = client(() => { throw new Error('404'); }, { listCustomers: vi.fn(async () => [make(1)]) });
    renderPage(api);
    expect(await grid().findByText('고객0001')).toBeInTheDocument();
  });

  it('이번 달 신규와 최근 등록을 인사이트에 보여 준다', async () => {
    const createdNow = new Date().toISOString();
    const { api } = client((_m, url) => (url.pathname.endsWith('/customers/search') ? { items: [make(1, { created_at: createdNow })], total: 1, next_cursor: null } : []));
    renderPage(api);
    await grid().findByText('고객0001');
    expect(screen.getByRole('region', { name: '고객 현황' })).toHaveTextContent('이번 달 신규1');
    expect(within(screen.getByRole('region', { name: '최근 등록' })).getByText('고객0001')).toBeInTheDocument();
  });
});

describe('보관 고객 복원', () => {
  const archived = [make(1, { status: 'archived' }), make(2, { status: 'archived', notes: '[병합되어 보관됨: 김대표]' }), make(3)];
  const handler: Handler = (_m, url) => (url.pathname.endsWith('/customers/search') ? { items: archived, total: 3, next_cursor: null } : []);

  it('보관 고객 필터에서만 복원 버튼이 보이고 표시된 고객을 한 번에 복원한다', async () => {
    const { api } = client(handler);
    renderPage(api);
    await grid().findByText('고객0003');
    expect(screen.queryByRole('group', { name: '보관 고객 복원' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('상태 필터'), { target: { value: 'archived' } });
    const bar = screen.getByRole('group', { name: '보관 고객 복원' });
    expect(within(bar).getByRole('button', { name: '선택 고객 복원' })).toBeDisabled();
    fireEvent.click(within(bar).getByRole('button', { name: '표시된 2명 복원' }));
    expect(await screen.findByText(/중복 고객이 다시 생깁니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '복원' }));
    await waitFor(() => expect(api.updateCustomer).toHaveBeenCalledTimes(2));
    expect(api.updateCustomer).toHaveBeenCalledWith(org, archived[0]!.id, { status: 'active' });
    expect(api.updateCustomer).toHaveBeenCalledWith(org, archived[1]!.id, { status: 'active' });
    await waitFor(() => expect(within(screen.getByRole('group', { name: '보관 고객 복원' })).getByRole('button', { name: '표시된 0명 복원' })).toBeDisabled());
  });

  it('선택한 보관 고객 한 명을 복원하고 보기 전용 화면에는 복원·태그·병합 버튼이 없다', async () => {
    const { api } = client(handler);
    renderPage(api);
    await grid().findByText('고객0003');
    fireEvent.change(screen.getByLabelText('상태 필터'), { target: { value: 'archived' } });
    fireEvent.click(grid().getByText('고객0001'));
    await screen.findByRole('heading', { name: '고객0001' });
    fireEvent.click(screen.getByRole('button', { name: '선택 고객 복원' }));
    fireEvent.click(await screen.findByRole('button', { name: '복원' }));
    await waitFor(() => expect(api.updateCustomer).toHaveBeenCalledWith(org, archived[0]!.id, { status: 'active' }));
    expect(api.updateCustomer).toHaveBeenCalledTimes(1);
  });

  it('보기 전용이면 관리 버튼을 숨긴다', async () => {
    const { api } = client(handler);
    renderPage(api, true);
    await grid().findByText('고객0003');
    fireEvent.change(screen.getByLabelText('상태 필터'), { target: { value: 'archived' } });
    expect(screen.queryByRole('group', { name: '보관 고객 복원' })).not.toBeInTheDocument();
    for (const name of ['태그 관리', '중복 병합']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });
});

describe('태그 관리', () => {
  const tags = [{ tag: '재방문', count: 3 }, { tag: 'VIP', count: 1 }, { tag: '신규', count: 2 }];
  const handler: Handler = (method, url) => {
    if (url.pathname.endsWith('/customers/search')) return { items: [make(1)], total: 1, next_cursor: null };
    if (url.pathname.endsWith('/customer-tags')) return tags;
    if (method === 'POST' && url.pathname.includes('/customer-tags/')) return { updated: 3 };
    return [];
  };
  const open = async (api: ApiClient) => {
    renderPage(api);
    await grid().findByText('고객0001');
    fireEvent.click(screen.getByRole('button', { name: '태그 관리' }));
    return screen.findByRole('table', { name: '태그 목록' });
  };

  it('태그와 사용 고객 수를 보여 준다', async () => {
    const { api } = client(handler);
    const table = await open(api);
    expect(within(table).getByText('재방문')).toBeInTheDocument();
    expect(within(table).getByText('3명')).toBeInTheDocument();
  });

  it('이름을 바꾸면 확인 후 서버에 요청하고 목록을 다시 읽는다', async () => {
    const { api, call } = client(handler);
    const table = await open(api);
    const row = within(table).getByText('신규').closest('[role="row"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '이름 바꾸기' }));
    fireEvent.change(within(row).getByLabelText('새 태그 이름'), { target: { value: '새고객' } });
    fireEvent.click(within(row).getByRole('button', { name: '적용' }));
    fireEvent.click(await screen.findByRole('button', { name: '바꾸기' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('POST', `/organizations/${org}/customer-tags/rename`, expect.anything(), { from: '신규', to: '새고객' }));
  });

  it('둘 이상을 골라 하나로 병합한다', async () => {
    const { api, call } = client(handler);
    const table = await open(api);
    fireEvent.click(within(table).getByLabelText('재방문 선택'));
    fireEvent.click(within(table).getByLabelText('VIP 선택'));
    fireEvent.click(screen.getByRole('button', { name: /선택 병합/ }));
    const form = screen.getByRole('form', { name: '태그 병합' });
    expect(within(form).getByLabelText('합칠 태그 이름')).toHaveValue('재방문');
    fireEvent.click(within(form).getByRole('button', { name: '병합' }));
    await screen.findByText(/하나로 합칩니다/);
    const mergeButtons = screen.getAllByRole('button', { name: '병합' });
    fireEvent.click(mergeButtons[mergeButtons.length - 1]!);
    await waitFor(() => expect(call).toHaveBeenCalledWith('POST', `/organizations/${org}/customer-tags/merge`, expect.anything(), { from: ['VIP'], to: '재방문' }));
  });

  it('삭제는 사용 중인 고객 수를 알리고 확인 뒤에 한다', async () => {
    const { api, call } = client(handler);
    const table = await open(api);
    const row = within(table).getByText('VIP').closest('[role="row"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '삭제' }));
    expect(await screen.findByText(/1명의 고객에서 이 태그를 지웁니다/)).toBeInTheDocument();
    const confirmButtons = screen.getAllByRole('button', { name: '삭제' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);
    await waitFor(() => expect(call).toHaveBeenCalledWith('POST', `/organizations/${org}/customer-tags/delete`, expect.anything(), { tag: 'VIP' }));
  });

  it('목록을 읽지 못하면 오류와 다시 시도를 보여 준다', async () => {
    const { api } = client((_m, url) => {
      if (url.pathname.endsWith('/customers/search')) return { items: [make(1)], total: 1, next_cursor: null };
      throw new Error('boom');
    });
    renderPage(api);
    await grid().findByText('고객0001');
    fireEvent.click(screen.getByRole('button', { name: '태그 관리' }));
    expect(await screen.findByText(/태그 목록을 불러오지 못했습니다/)).toBeInTheDocument();
  });
});

describe('중복 병합', () => {
  const rows = [
    make(1, { name: '김대표', phone: '010-1111-2222', notes: '대표 메모', created_at: '2026-01-01T00:00:00Z' }),
    make(2, { name: '김보조', phone: '01011112222', email: 'a@b.com', notes: '보조 메모', created_at: '2026-02-01T00:00:00Z' }),
    make(3, { name: '박다른', phone: '010-9999-0000' }),
  ];
  const handler: Handler = (method, url, body) => {
    if (url.pathname.endsWith('/customers/search')) return { items: rows, total: 3, next_cursor: null };
    if (method === 'POST' && url.pathname.endsWith('/merge')) return { primary: rows[0], secondary_id: (body as { secondary_id: string }).secondary_id, moved: { appointments: 1 } };
    return [];
  };

  it('같은 연락처 후보를 찾아 대표 고객으로 합치고 값 선택을 서버에 보낸다', async () => {
    const { api, call } = client(handler);
    renderPage(api);
    await grid().findByText('김대표');
    fireEvent.click(screen.getByRole('button', { name: '중복 병합' }));
    const groups = await screen.findByRole('list', { name: '중복 후보 목록' });
    expect(within(groups).getByText('김대표, 김보조')).toBeInTheDocument();
    expect(within(groups).getByText(/같은 연락처 · 2명/)).toBeInTheDocument();
    expect(screen.getByLabelText('합친 메모')).toHaveValue('대표 메모\n\n[병합: 김보조]\n보조 메모');
    fireEvent.click(screen.getByRole('button', { name: /명을 '김대표'에 병합/ }));
    expect(await screen.findByText(/삭제하지 않고 보관 처리합니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '병합 실행' }));
    await waitFor(() => expect(call.mock.calls.some((entry) => String(entry[1]).endsWith('/merge'))).toBe(true));
    const merge = call.mock.calls.find((entry) => String(entry[1]).endsWith('/merge'))!;
    expect(merge[1]).toBe(`/organizations/${org}/customers/${rows[0]!.id}/merge`);
    expect(merge[3]).toMatchObject({ secondary_id: rows[1]!.id, operation_id: expect.any(String), resolved: { name: '김대표', email: 'a@b.com', notes: '대표 메모\n\n[병합: 김보조]\n보조 메모' } });
  });

  it('대표 고객을 바꾸면 합치는 방향이 바뀐다', async () => {
    const { api, call } = client(handler);
    renderPage(api);
    await grid().findByText('김대표');
    fireEvent.click(screen.getByRole('button', { name: '중복 병합' }));
    await screen.findByRole('list', { name: '중복 후보 목록' });
    const primary = screen.getByRole('group', { name: /대표 고객/ });
    fireEvent.click(within(primary).getAllByRole('radio')[1]!);
    fireEvent.click(await screen.findByRole('button', { name: /명을 '김보조'에 병합/ }));
    fireEvent.click(await screen.findByRole('button', { name: '병합 실행' }));
    await waitFor(() => expect(call.mock.calls.some((entry) => String(entry[1]).endsWith('/merge'))).toBe(true));
    expect(call.mock.calls.find((entry) => String(entry[1]).endsWith('/merge'))![1]).toBe(`/organizations/${org}/customers/${rows[1]!.id}/merge`);
  });

  it('병합이 실패하면 사유를 보여 주고 병합 후보는 그대로 둔다', async () => {
    const { api } = client((method, url, body) => {
      if (method === 'POST' && url.pathname.endsWith('/merge')) { const error = new Error('conflict') as Error & { status: number }; error.status = 409; throw error; }
      return handler(method, url, body);
    });
    renderPage(api);
    await grid().findByText('김대표');
    fireEvent.click(screen.getByRole('button', { name: '중복 병합' }));
    await screen.findByRole('list', { name: '중복 후보 목록' });
    fireEvent.click(screen.getByRole('button', { name: /명을 '김대표'에 병합/ }));
    fireEvent.click(await screen.findByRole('button', { name: '병합 실행' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('병합하지 못했습니다');
    expect(screen.getByRole('list', { name: '중복 후보 목록' })).toHaveTextContent('김대표, 김보조');
  });

  it('중복이 없으면 안내를 보여 준다', async () => {
    const { api } = client((_m, url) => (url.pathname.endsWith('/customers/search') ? { items: [rows[0], rows[2]], total: 2, next_cursor: null } : []));
    renderPage(api);
    await grid().findByText('김대표');
    fireEvent.click(screen.getByRole('button', { name: '중복 병합' }));
    expect(await screen.findByText('중복으로 보이는 고객이 없습니다.')).toBeInTheDocument();
  });
});
