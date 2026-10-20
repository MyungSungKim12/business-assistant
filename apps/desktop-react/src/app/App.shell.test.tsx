import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { usePreferences } from '../store/preferences';
import { useSessionStore } from '../store/session';
import { workspaceCache } from '../store/ttlCache';
import { App } from './App';
import type { AppServices } from './services';

const ORG = '22222222-2222-4222-8222-222222222222';
const session = { access_token: 'access', refresh_token: 'refresh', user: { user_id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com', display_name: '원장' } };
const customer = { id: '44444444-4444-4444-8444-444444444444', organization_id: ORG, name: '박검색', email: null, phone: '010-5555-6666', notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active' };

function services(options: { role?: string; platformAdmin?: boolean | 'fail'; login?: () => Promise<unknown> } = {}): AppServices & { api: Record<string, ReturnType<typeof vi.fn>> } {
  const api = {
    login: vi.fn(options.login ?? (async () => session)), restoreSession: vi.fn(async () => ({ authenticated: false as const })), logout: vi.fn(async () => undefined),
    listOrganizations: vi.fn(async () => [{ id: ORG, name: '베이지 살롱', slug: 'beige', role: options.role ?? 'owner' }]),
    getEntitlements: vi.fn(async () => ({ organization_id: ORG, plan_code: 'pro', features: ['crm.basic'] })),
    listCustomers: vi.fn(async () => [customer]), listTasks: vi.fn(async () => []), call: vi.fn(async () => []), listOperationRecords: vi.fn(async () => []),
    isPlatformAdmin: vi.fn(async () => { if (options.platformAdmin === 'fail') throw new Error('x'); return options.platformAdmin === true; }),
  };
  return { api, platform: { kind: 'browser', apiBase: '/api/v1', tokenStore: {} as never, request: vi.fn(), uploadBinary: vi.fn(), downloadBinary: vi.fn(), subscribeConnection(listener: (state: string) => void) { listener('online'); return () => undefined; } } } as never;
}

async function login() {
  await screen.findByRole('button', { name: '로그인' });
  fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'owner@example.com' } });
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: '로그인' }));
  await screen.findAllByText('베이지 살롱');
}
const openMore = () => fireEvent.click(screen.getByRole('button', { name: /더보기/ }));

beforeEach(() => { localStorage.clear(); useSessionStore.getState().reset(); usePreferences.getState().load(null); workspaceCache.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe('앱 셸: 구독 메뉴(ADM-10)와 구성원 메뉴(TEAM-10)', () => {
  it('플랫폼 관리자로 확인된 경우에만 구독 메뉴가 보인다', async () => {
    render(<App services={services({ platformAdmin: true })} />); await login();
    await waitFor(() => { openMore(); expect(screen.queryByRole('menuitem', { name: /구독/ })).toBeInTheDocument(); });
  });

  it.each([[false], ['fail' as const]])('관리자 확인이 %s 이면 구독 메뉴가 숨겨지지만 구성원 메뉴는 소유자에게 보인다', async (platformAdmin) => {
    const svc = services({ platformAdmin });
    render(<App services={svc} />); await login();
    await waitFor(() => expect(svc.api.isPlatformAdmin).toHaveBeenCalled());
    openMore();
    expect(screen.getByRole('menuitem', { name: /구성원/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /구독/ })).not.toBeInTheDocument();
  });

  it('구성원(member) 역할에게는 구성원 메뉴가 보이지 않는다', async () => {
    render(<App services={services({ role: 'member' })} />); await login();
    openMore();
    expect(screen.queryByRole('menuitem', { name: /구성원/ })).not.toBeInTheDocument();
  });
});

describe('앱 셸: 전체 검색(UX-02)', () => {
  it('고객 입력은 메뉴 이동·로그아웃·브라우저 종료 전에 보호된다', async () => {
    const svc=services();
    svc.api.call.mockImplementation(async (_method:string,path:string) => path.includes('/customers/search') ? {items:[customer],total:1,next_cursor:null} : []);
    svc.api.listCustomerPhotos=vi.fn(async()=>[]);
    svc.api.listCustomerActivities=vi.fn(async()=>[]);
    render(<App services={svc}/>); await login();
    fireEvent.click(screen.getByRole('button',{name:'고객관리'}));
    const grid=await screen.findByRole('grid',{name:'고객 목록'});
    fireEvent.click(await within(grid).findByText('박검색'));
    await screen.findByDisplayValue('박검색');
    fireEvent.change(screen.getByLabelText('이름'),{target:{value:'작성 중 이름'}});
    const unload=new Event('beforeunload',{cancelable:true});
    fireEvent(window,unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'홈'}));
    let guard=await screen.findByRole('dialog',{name:'저장하지 않은 변경'});
    fireEvent.click(within(guard).getByRole('button',{name:'계속 작성'}));
    await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('이름')).toHaveValue('작성 중 이름');
    fireEvent.click(screen.getByRole('button',{name:'로그아웃'}));
    const logout=await screen.findByRole('dialog',{name:'로그아웃'});
    fireEvent.click(within(logout).getByRole('button',{name:'로그아웃'}));
    guard=await screen.findByRole('dialog',{name:'저장하지 않은 변경'});
    fireEvent.click(within(guard).getByRole('button',{name:'계속 작성'}));
    await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(svc.api.logout).not.toHaveBeenCalled();
    expect(screen.getByLabelText('이름')).toHaveValue('작성 중 이름');
  });

  it('Ctrl+K 로 팔레트를 열고 고객을 선택하면 고객관리로 이동한다', async () => {
    render(<App services={services()} />); await login();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: '검색어' });
    fireEvent.change(input, { target: { value: '박검색' } });
    fireEvent.click(await screen.findByRole('option', { name: /박검색/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: '고객관리' })).toHaveAttribute('aria-current', 'page'));
    expect(screen.queryByRole('combobox', { name: '검색어' })).not.toBeInTheDocument();
  });

  it('상단 검색 버튼으로도 열리고 메뉴 이동 결과를 고를 수 있다', async () => {
    render(<App services={services()} />); await login();
    fireEvent.click(screen.getByRole('button', { name: /전체 검색/ }));
    const input = await screen.findByRole('combobox', { name: '검색어' });
    fireEvent.change(input, { target: { value: '구성원' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('heading', { name: '구성원' })).toBeInTheDocument();
  });
});

describe('앱 셸: 알림 센터(UX-03)', () => {
  it('상단바에 알림 벨이 있고 열면 패널이 보인다', async () => {
    render(<App services={services()} />); await login();
    fireEvent.click(screen.getByRole('button', { name: /^알림/ }));
    expect(screen.getByRole('dialog', { name: '알림 센터' })).toBeInTheDocument();
  });
});

describe('앱 셸: 유휴 자동 잠금(SEC-08)', () => {
  async function lockedApp(loginImpl?: () => Promise<unknown>) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const svc = services({ login: loginImpl });
    render(<App services={svc} />); await login();
    act(() => { usePreferences.getState().setIdleLockMinutes(5); });
    act(() => { vi.advanceTimersByTime(6 * 60_000); });
    return svc;
  }

  it('설정 시간 동안 입력이 없으면 잠금 화면이 뜨고 뒤 화면은 입력을 받지 못한다', async () => {
    await lockedApp();
    const lock = await screen.findByRole('dialog', { name: '화면이 잠겼습니다' });
    expect(within(lock).getByLabelText('이메일')).toHaveValue('owner@example.com');
    expect(document.querySelector('.app-shell')).toHaveAttribute('inert');
  });

  it('비밀번호를 다시 확인하면 해제되고 화면 상태는 유지된다', async () => {
    const svc = await lockedApp();
    fireEvent.change(await screen.findByLabelText('비밀번호'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '잠금 해제' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '화면이 잠겼습니다' })).not.toBeInTheDocument());
    expect(svc.api.login).toHaveBeenLastCalledWith('owner@example.com', 'secret');
    expect(document.querySelector('.app-shell')).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: '고객관리' })).toBeInTheDocument();
  });

  it('비밀번호가 틀리면 잠금이 유지되고 안내한다', async () => {
    let attempt = 0;
    await lockedApp(async () => { attempt += 1; if (attempt > 1) throw new ApiError(401, 'HTTP_401', 'x', false); return session; });
    fireEvent.change(await screen.findByLabelText('비밀번호'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '잠금 해제' }));
    expect(await within(screen.getByRole('dialog', { name: '화면이 잠겼습니다' })).findByRole('alert')).toHaveTextContent('비밀번호를 확인해 주세요.');
    expect(screen.getByRole('dialog', { name: '화면이 잠겼습니다' })).toBeInTheDocument();
  });

  it('잠긴 동안에는 Ctrl+K 검색이 열리지 않는다', async () => {
    await lockedApp();
    await screen.findByRole('dialog', { name: '화면이 잠겼습니다' });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('combobox', { name: '검색어' })).not.toBeInTheDocument();
  });

  it('설정이 끔이면 잠기지 않는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App services={services()} />); await login();
    act(() => { vi.advanceTimersByTime(60 * 60_000); });
    expect(screen.queryByRole('dialog', { name: '화면이 잠겼습니다' })).not.toBeInTheDocument();
  });
});

describe('앱 셸: 사용성 설정(UX-05)·새 버전 알림(OPS-04)', () => {
  const prefsKey = 'business-assistant.prefs.11111111-1111-4111-8111-111111111111';

  it('저장된 시작 화면으로 로그인 직후 이동하고, 알림 센터를 끄면 숨긴다', async () => {
    localStorage.setItem(prefsKey, JSON.stringify({ startMenu: 'customers', notificationsEnabled: false, fontScale: 1.1 }));
    render(<App services={services()} />); await login();
    await waitFor(() => expect(screen.getByRole('button', { name: '고객관리' })).toHaveAttribute('aria-current', 'page'));
    expect(screen.queryByRole('button', { name: /알림/ })).not.toBeInTheDocument();
    expect(document.documentElement.style.zoom).toBe('1.1');
  });

  it('자동 확인된 새 버전을 알리고, 알림을 끄면 구독하지 않는다', async () => {
    let handler: ((info: { version: string }) => void) | undefined;
    const svc = services();
    (svc.platform as unknown as Record<string, unknown>).onUpdateAvailable = vi.fn(async (fn: (info: { version: string }) => void) => { handler = fn; return () => undefined; });
    render(<App services={svc} />); await login();
    await waitFor(() => expect(handler).toBeDefined());
    act(() => handler!({ version: '0.3.0' }));
    expect(await screen.findByText(/새 버전 0\.3\.0/)).toBeInTheDocument();
  });

  it('새 버전 알림 설정이 꺼져 있으면 이벤트를 구독하지 않는다', async () => {
    localStorage.setItem(prefsKey, JSON.stringify({ updateNotice: false }));
    const svc = services();
    const subscribe = vi.fn(async () => () => undefined);
    (svc.platform as unknown as Record<string, unknown>).onUpdateAvailable = subscribe;
    render(<App services={svc} />); await login();
    await screen.findAllByText('베이지 살롱');
    expect(subscribe).not.toHaveBeenCalled();
  });
});
