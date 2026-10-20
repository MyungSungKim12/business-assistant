import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { MenuId } from '../shell/TopBar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDataApi } from '../../store/workspaceData';
import { workspaceCache } from '../../store/ttlCache';
import { NotificationCenter } from './NotificationCenter';
import { readStateKey } from './readState';
import { useNotifications } from './useNotifications';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = ID(900);
const NOW = new Date('2026-10-13T05:00:00Z');
const appointment = { id: ID(100), organization_id: ORG, customer_id: ID(1), staff_id: ID(5), service_id: ID(6), service_name_snapshot: '관리 60분', duration_minutes: 60, buffer_minutes: 0, start_at: '2026-10-13T05:30:00Z', end_at: '2026-10-13T06:30:00Z', status: 'reserved', source: 'phone', cancellation_reason: null, version: 1, resource_ids: [] };
const customer = { id: ID(1), organization_id: ORG, name: '김하나', email: null, phone: '010-1234-5678', notes: '', birth_date: '1990-10-15', skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active' };
const task = { id: ID(200), organization_id: ORG, created_by: 'user-1', title: '재고 확인', description: '', due_at: '2026-10-10T03:00:00Z', status: 'open', priority: 'normal' };
const wallet = { id: 'w1', customer_id: ID(1), name_snapshot: '10회권', count_balance: 2, expires_on: '2026-10-20' };

function fakeApi(overrides: Partial<Record<keyof WorkspaceDataApi, unknown>> = {}) {
  const api = {
    listCustomers: vi.fn().mockResolvedValue([customer]),
    listTasks: vi.fn().mockResolvedValue([task]),
    call: vi.fn().mockResolvedValue([appointment]),
    listOperationRecords: vi.fn().mockResolvedValue([wallet]),
    ...overrides,
  };
  return api as typeof api & WorkspaceDataApi;
}

beforeEach(() => { localStorage.clear(); workspaceCache.clear(); });
afterEach(() => { vi.useRealTimers(); });

function Harness({ api, onNavigate = () => undefined }: { api: WorkspaceDataApi; onNavigate?: (id: MenuId) => void }) {
  const state = useNotifications({ api, organizationId: ORG, userId: 'user-1', enabled: true, now: () => NOW });
  return <NotificationCenter state={state} onNavigate={onNavigate} />;
}

describe('NotificationCenter', () => {
  it('벨에 읽지 않은 알림 수 배지가 뜨고 패널에 종류별로 보인다', async () => {
    render(<Harness api={fakeApi()} />);
    const bell = await screen.findByRole('button', { name: '알림 4건' });
    fireEvent.click(bell);
    const panel = screen.getByRole('dialog', { name: '알림 센터' });
    expect(panel).toHaveTextContent('오늘 14:30 김하나');
    expect(panel).toHaveTextContent('30분 후 · 관리 60분');
    expect(panel).toHaveTextContent('재고 확인');
    expect(panel).toHaveTextContent('기한 3일 지남');
    expect(panel).toHaveTextContent('김하나 고객 생일');
    expect(panel).toHaveTextContent('김하나 · 10회권');
    expect(panel).toHaveTextContent('임박');
  });

  it('항목을 누르면 읽음 처리하고 해당 메뉴로 이동하며 읽음은 사용자별로 저장된다', async () => {
    const onNavigate = vi.fn();
    render(<Harness api={fakeApi()} onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByRole('button', { name: '알림 4건' }));
    fireEvent.click(screen.getByRole('button', { name: /재고 확인/ }));
    expect(onNavigate).toHaveBeenCalledWith('tasks');
    expect(screen.queryByRole('dialog', { name: '알림 센터' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '알림 3건' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(readStateKey('user-1'))!)).toEqual([`task:${ID(200)}:2026-10-10`]);
  });

  it('모두 읽음 처리하면 배지가 사라진다', async () => {
    render(<Harness api={fakeApi()} />);
    fireEvent.click(await screen.findByRole('button', { name: '알림 4건' }));
    fireEvent.click(screen.getByRole('button', { name: '모두 읽음' }));
    expect(screen.getByRole('button', { name: '알림' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '모두 읽음' })).toBeDisabled();
  });

  it('Esc 로 닫는다', async () => {
    render(<Harness api={fakeApi()} />);
    fireEvent.click(await screen.findByRole('button', { name: '알림 4건' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '알림 센터' })).not.toBeInTheDocument();
  });

  it('일부 데이터를 불러오지 못해도 나머지 알림은 보이고 안내한다', async () => {
    render(<Harness api={fakeApi({ listOperationRecords: vi.fn().mockRejectedValue(new Error('x')) })} />);
    fireEvent.click(await screen.findByRole('button', { name: '알림 3건' }));
    expect(screen.getByRole('status')).toHaveTextContent('일부 알림을 불러오지 못했습니다');
  });

  it('알림이 없으면 안내 문구를 보여 준다', async () => {
    const api = fakeApi({ listCustomers: vi.fn().mockResolvedValue([]), listTasks: vi.fn().mockResolvedValue([]), call: vi.fn().mockResolvedValue([]), listOperationRecords: vi.fn().mockResolvedValue([]) });
    render(<Harness api={api} />);
    await waitFor(() => expect(api.listTasks).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '알림' }));
    expect(await screen.findByText('새 알림이 없습니다.')).toBeInTheDocument();
  });
});

describe('useNotifications', () => {
  it('이미 읽은 알림은 다시 불러와도 읽음으로 남고, 지난 알림 기록은 정리한다', async () => {
    localStorage.setItem(readStateKey('user-1'), JSON.stringify([`task:${ID(200)}:2026-10-10`, 'task:old:2026-01-01']));
    const { result } = renderHook(() => useNotifications({ api: fakeApi(), organizationId: ORG, userId: 'user-1', enabled: true, now: () => NOW }));
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    expect(result.current.unreadCount).toBe(3);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(readStateKey('user-1'))!)).toEqual([`task:${ID(200)}:2026-10-10`]));
  });

  it('5분마다 다시 불러온다', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    renderHook(() => useNotifications({ api, organizationId: ORG, userId: 'user-1', enabled: true, now: () => NOW }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.listTasks).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(api.listTasks).toHaveBeenCalledTimes(2);
  });

  it('비활성(잠금 중)이면 불러오지 않는다', async () => {
    const api = fakeApi();
    renderHook(() => useNotifications({ api, organizationId: ORG, userId: 'user-1', enabled: false, now: () => NOW }));
    await act(async () => { await Promise.resolve(); });
    expect(api.listTasks).not.toHaveBeenCalled();
  });

  it('저장소를 쓸 수 없어도 오류 없이 동작한다', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { result } = renderHook(() => useNotifications({ api: fakeApi(), organizationId: ORG, userId: 'user-1', enabled: true, now: () => NOW }));
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    expect(() => act(() => result.current.markAllRead())).not.toThrow();
    expect(result.current.unreadCount).toBe(0);
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
