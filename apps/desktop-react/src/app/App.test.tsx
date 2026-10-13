import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import type { AppServices } from './services';
import { App } from './App';
import { useSessionStore } from '../store/session';

const session = { access_token: 'access', refresh_token: 'refresh', user: { user_id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com', display_name: '원장' } };
const organizations = [{ id: '22222222-2222-4222-8222-222222222222', name: '베이지 살롱', slug: 'beige', role: 'owner' }];

function services(overrides: Partial<AppServices['api']> = {}): AppServices {
  const api = {
    login: vi.fn(async () => session), restoreSession: vi.fn(async () => ({ authenticated: false as const })), logout: vi.fn(async () => undefined),
    listOrganizations: vi.fn(async () => organizations), getEntitlements: vi.fn(async () => ({ organization_id: organizations[0].id, plan_code: 'pro', features: ['crm.basic'] })), listCustomers: vi.fn(async()=>[]), listTasks:vi.fn(async()=>[]),
    ...overrides,
  };
  return { api, platform: { kind: 'browser', apiBase: '/api/v1', tokenStore: {} as never, request: vi.fn(), uploadBinary: vi.fn(), downloadBinary: vi.fn(), subscribeConnection(listener) { listener('online'); return () => undefined; } } };
}

async function login() {
  await screen.findByRole('button', { name: '로그인' });
  fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'owner@example.com' } });
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: '로그인' }));
}

describe('App', () => {
  beforeEach(() => useSessionStore.getState().reset());

  it('automatically selects a sole organization and renders the top shell', async () => {
    render(<App services={services()} />); await login();
    expect(await screen.findByText('베이지 살롱')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '고객관리' })).toBeInTheDocument();
    expect(screen.getByText('원장')).toBeInTheDocument();
  });

  it('asks when there are multiple organizations and explains an empty account', async () => {
    const two = [...organizations, { ...organizations[0], id: '33333333-3333-4333-8333-333333333333', name: '두 번째 매장' }];
    const many = services({ listOrganizations: vi.fn(async () => two) });
    const view = render(<App services={many} />); await login();
    expect(await screen.findByRole('heading', { name: '매장 선택' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /두 번째 매장/ }));
    expect(await screen.findByRole('heading', { name: '오늘의 매장' })).toBeInTheDocument();
    view.unmount(); useSessionStore.getState().reset();
    render(<App services={services({ listOrganizations: vi.fn(async () => []) })} />); await login();
    expect(await screen.findByText('접근 가능한 매장이 없습니다.')).toBeInTheDocument();
  });

  it('hides customer access without entitlement and marks members read only', async () => {
    const member = [{ ...organizations[0], role: 'member' }];
    render(<App services={services({ listOrganizations: vi.fn(async () => member), getEntitlements: vi.fn(async () => ({ organization_id: member[0].id, plan_code: 'basic', features: [] })) })} />);
    await login(); await screen.findByText('베이지 살롱');
    expect(screen.queryByRole('button', { name: '고객관리' })).not.toBeInTheDocument();
    expect(screen.getByText('읽기 전용')).toBeInTheDocument();
  });

  it('returns to login after failed restore and shows a permission error', async () => {
    const restore = services({ restoreSession: vi.fn(async () => ({ authenticated: false as const })) });
    const first = render(<App services={restore} />);
    expect(await screen.findByRole('button', { name: '로그인' })).toBeInTheDocument();
    first.unmount(); useSessionStore.getState().reset();
    render(<App services={services({ getEntitlements: vi.fn(async () => { throw new ApiError(403, 'FORBIDDEN', '권한이 없습니다.', false); }) })} />);
    await login();
    expect(await screen.findByText('이 매장을 볼 권한이 없습니다.')).toBeInTheDocument();
  });

  it('opens settings and reports unavailable update support', async () => {
    render(<App services={services()} />); await login(); await screen.findByText('베이지 살롱');
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    expect(await screen.findByText('패키징 단계에서 지원 예정')).toBeInTheDocument();
  });
});
