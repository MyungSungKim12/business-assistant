import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Appointment, Customer, Task } from '../../api/schemas';
import { usePreferences } from '../../store/preferences';
import { workspaceCache } from '../../store/ttlCache';
import type { WorkspaceDataApi } from '../../store/workspaceData';
import { SearchPalette } from './SearchPalette';
import { SEARCH_LIMITS, buildSearchResults, queryTokens, type SearchMenu } from './searchModel';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = ID(900);
const NOW = new Date('2026-10-13T05:00:00Z');
const menus: SearchMenu[] = [
  { id: 'dashboard', label: '홈', description: '오늘의 매장' }, { id: 'tasks', label: '할 일', description: '할 일과 일정' },
  { id: 'customers', label: '고객관리', description: '고객 정보와 상담 이력' }, { id: 'members', label: '구성원', description: '매장 구성원 초대·역할 관리' },
];
const customer = (n: number, patch: Partial<Customer> = {}): Customer => ({
  id: ID(n), organization_id: ORG, name: `고객${n}`, email: null, phone: null, notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '',
  last_visit_date: null, next_visit_date: null, tags: [], status: 'active', ...patch,
});
const appointment = (n: number, startKst: string, patch: Partial<Appointment> = {}): Appointment => ({
  id: ID(100 + n), organization_id: ORG, customer_id: ID(1), staff_id: ID(5), service_id: ID(6), service_name_snapshot: '피부관리', duration_minutes: 60, buffer_minutes: 0,
  start_at: new Date(`${startKst}+09:00`).toISOString(), end_at: new Date(`${startKst}+09:00`).toISOString(), status: 'reserved', source: 'phone', cancellation_reason: null, version: 1, resource_ids: [], ...patch,
});
const task = (n: number, title: string, patch: Partial<Task> = {}): Task => ({
  id: ID(200 + n), organization_id: ORG, created_by: ID(7), title, description: '', due_at: null, status: 'open', priority: 'normal', ...patch,
});
const data = {
  customers: [customer(1, { name: '김하나', phone: '010-1234-5678' }), customer(2, { name: '김둘', phone: '010-9999-0000' }), customer(3, { name: '보관고객', status: 'archived' })],
  appointments: [appointment(1, '2026-10-14T10:00:00'), appointment(2, '2026-10-12T10:00:00'), appointment(3, '2026-10-15T10:00:00', { status: 'canceled' }), appointment(4, '2027-03-01T10:00:00')],
  tasks: [task(1, '재료 주문'), task(2, '완료된 재료', { status: 'done' })],
};
const search = (query: string, extra: Partial<Parameters<typeof buildSearchResults>[0]> = {}) => buildSearchResults({ query, menus, data, now: NOW, ...extra });
const titles = (results: Array<{ title: string }>) => results.map((result) => result.title);

describe('buildSearchResults', () => {
  it('입력이 없으면 메뉴만 보여 준다', () => {
    const results = search('');
    expect(results.every((result) => result.kind === 'menu')).toBe(true);
    expect(results).toHaveLength(menus.length);
  });

  it('메뉴는 이름·설명으로 찾는다', () => {
    expect(titles(search('구성원'))).toContain('구성원');
    expect(titles(search('상담'))).toEqual(['고객관리']);
  });

  it('고객은 이름과 연락처(숫자만 비교)로 찾고 보관 고객은 제외한다', () => {
    expect(titles(search('김').filter((result) => result.kind === 'customer'))).toEqual(['김하나', '김둘']);
    const byPhone = search('1234').filter((result) => result.kind === 'customer');
    expect(titles(byPhone)).toEqual(['김하나']);
    expect(byPhone[0]).toMatchObject({ menu: 'customers', focus: { kind: 'customer', id: ID(1) } });
    expect(search('010-9999').filter((result) => result.kind === 'customer')).toHaveLength(1);
    expect(titles(search('보관'))).not.toContain('보관고객');
  });

  it('연락처는 가림 옵션을 반영해 표시하되 원본 번호로 검색한다', () => {
    const results = search('1234', { phone: (value) => (value ? '***' : '') }).filter((result) => result.kind === 'customer');
    expect(results[0].subtitle).toBe('***');
  });

  it('예약은 오늘 이후·취소 제외·60일 이내만, 날짜·시각·고객·서비스로 찾는다', () => {
    const byName = search('김하나').filter((result) => result.kind === 'appointment');
    expect(byName.map((result) => result.title)).toEqual(['10-14 10:00 김하나']);
    expect(byName[0]).toMatchObject({ menu: 'appointments', subtitle: '피부관리', focus: { kind: 'appointment', id: ID(101) } });
    expect(search('10-12').filter((result) => result.kind === 'appointment')).toEqual([]);
    expect(search('10-15').filter((result) => result.kind === 'appointment')).toEqual([]);
    expect(search('2027-03-01').filter((result) => result.kind === 'appointment')).toEqual([]);
    expect(search('피부').filter((result) => result.kind === 'appointment')).toHaveLength(1);
  });

  it('할 일은 미완료만 제목으로 찾는다', () => {
    const results = search('재료').filter((result) => result.kind === 'task');
    expect(titles(results)).toEqual(['재료 주문']);
    expect(results[0]).toMatchObject({ menu: 'tasks', focus: { kind: 'task', id: ID(201) } });
  });

  it('여러 단어는 모두 일치해야 하고 종류별 상한을 둔다', () => {
    expect(titles(search('김하나 피부').filter((result) => result.kind === 'appointment'))).toHaveLength(1);
    expect(search('김하나 없는단어')).toEqual([]);
    const many = { ...data, customers: Array.from({ length: 50 }, (_, i) => customer(10 + i, { name: `많은고객${i}` })) };
    expect(search('많은', { data: many }).filter((result) => result.kind === 'customer')).toHaveLength(SEARCH_LIMITS.customer);
    expect(queryTokens('  가  나 ')).toEqual(['가', '나']);
  });

  it('결과는 메뉴, 고객, 예약, 할 일 순서로 묶인다', () => {
    const kinds = search('김').map((result) => result.kind);
    expect(kinds).toEqual([...kinds].sort((a, b) => ['menu', 'customer', 'appointment', 'task'].indexOf(a) - ['menu', 'customer', 'appointment', 'task'].indexOf(b)));
  });
});

function fakeApi(overrides: Partial<Record<keyof WorkspaceDataApi, unknown>> = {}) {
  const api = {
    listCustomers: vi.fn().mockResolvedValue(data.customers),
    listTasks: vi.fn().mockResolvedValue(data.tasks),
    call: vi.fn().mockResolvedValue(data.appointments),
    listOperationRecords: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  return api as typeof api & WorkspaceDataApi;
}
function setup(api = fakeApi()) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(<SearchPalette api={api} organizationId={ORG} menus={menus} onClose={onClose} onSelect={onSelect} now={() => NOW} />);
  return { api, onSelect, onClose, input: screen.getByRole('combobox', { name: '검색어' }) };
}

beforeEach(() => { workspaceCache.clear(); usePreferences.getState().load(null); });

describe('SearchPalette', () => {
  it('열리면 입력창에 포커스가 있고 데이터를 지연 로드한다', async () => {
    const { api, input } = setup();
    expect(input).toHaveFocus();
    await waitFor(() => expect(api.listCustomers).toHaveBeenCalledTimes(1));
    expect(api.call).toHaveBeenCalledWith('GET', `/organizations/${ORG}/appointments?from_date=2026-10-13&to_date=2026-12-12`, expect.anything());
  });

  it('입력하면 유형별 그룹으로 보이고 Enter 로 첫 결과를 연다', async () => {
    const { input, onSelect } = setup();
    await waitFor(() => expect(screen.queryByText(/불러오는 중/)).not.toBeInTheDocument());
    fireEvent.change(input, { target: { value: '김하나' } });
    expect(screen.getByRole('group', { name: '고객' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '예약' })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'customer', menu: 'customers', focus: { kind: 'customer', id: ID(1) } }));
  });

  it('↑↓ 로 이동하고 순환하며 Enter 는 선택한 항목을 연다', async () => {
    const { input, onSelect } = setup();
    await waitFor(() => expect(screen.queryByText(/불러오는 중/)).not.toBeInTheDocument());
    fireEvent.change(input, { target: { value: '김' } });
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option').at(-1)).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('클릭으로 열고 Esc 로 닫는다', async () => {
    const { input, onSelect, onClose } = setup();
    fireEvent.change(input, { target: { value: '구성원' } });
    fireEvent.click(screen.getByRole('option', { name: /구성원/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'menu', menu: 'members' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('결과가 없으면 안내하고 Enter 는 아무것도 열지 않는다', async () => {
    const { input, onSelect } = setup();
    fireEvent.change(input, { target: { value: '없는검색어xyz' } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('일치하는 결과가 없습니다.'));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('일부 목록 로드가 실패해도 나머지로 검색하고 안내한다', async () => {
    const { input } = setup(fakeApi({ listTasks: vi.fn().mockRejectedValue(new Error('x')) }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('일부 목록은 불러오지 못했습니다'));
    fireEvent.change(input, { target: { value: '김하나' } });
    expect(screen.getByRole('group', { name: '고객' })).toBeInTheDocument();
  });

  it('전화번호 가림 옵션이 켜져 있으면 결과의 연락처를 가려서 보여 준다', async () => {
    usePreferences.getState().load('u1');
    usePreferences.getState().setMaskPhone(true);
    const { input } = setup();
    await waitFor(() => expect(screen.queryByText(/불러오는 중/)).not.toBeInTheDocument());
    fireEvent.change(input, { target: { value: '김하나' } });
    expect(screen.getAllByRole('option', { name: /김하나/ })[0]).toHaveTextContent('010-****-5678');
    expect(screen.queryByText('010-1234-5678')).not.toBeInTheDocument();
  });
});
