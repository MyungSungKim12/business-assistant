import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import type { Platform } from '../../platform/types';
import { IncomingCallAlerts } from './IncomingCallAlerts';
import { usePreferences } from '../../store/preferences';

const match = { customer_id: 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd', name: '전화고객', phone: '01012345678', phone_e164: '+821012345678' };
const event = { id: 'd9cc39fd-8e8c-4df8-a623-1f23a3a936bd', phone_e164: match.phone_e164, occurred_at: new Date().toISOString(), received_at: new Date().toISOString(), expires_at: new Date(Date.now() + 120_000).toISOString(), matches: [match] };
const pending = () => new Promise<never>(() => {});
describe('PC incoming call alerts', () => {
  it('sends only masked display numbers to native cards when privacy is enabled',async()=>{
    usePreferences.setState({maskPhone:true});
    try {
      const show=vi.fn(async()=>{});
      const api={listIncomingCalls:vi.fn().mockResolvedValueOnce({items:[event],cursor:'n'}).mockImplementation(pending)} as unknown as ApiClient;
      const view=render(<IncomingCallAlerts api={api} platform={{showIncomingCalls:show} as unknown as Platform} organizationId="org" userId="u" enabled osEnabled onDirtyChange={vi.fn()}/>);
      await waitFor(()=>expect(show).toHaveBeenCalledWith([expect.objectContaining({phone:expect.stringContaining('*')})]));
      expect(show.mock.calls.some(call=>JSON.stringify(call).includes(event.phone_e164))).toBe(false);
      view.unmount();
    }finally{usePreferences.setState({maskPhone:false});}
  });
  it('acknowledges customer navigation only when the main window accepts it',async()=>{
    let action:(id:string,kind?:'customer'|'retry',customer?:string)=>void=()=>{};
    const acknowledge=vi.fn(async()=>{}),open=vi.fn(async()=>false);
    const platform={showIncomingCalls:vi.fn(async()=>{}),completeIncomingCallAction:acknowledge,subscribeIncomingCallAction:async(handler:typeof action)=>{action=handler;return()=>{};}} as unknown as Platform;
    const api={listIncomingCalls:vi.fn().mockResolvedValueOnce({items:[event],cursor:'n'}).mockImplementation(pending)} as unknown as ApiClient;
    render(<IncomingCallAlerts api={api} platform={platform} organizationId="org" userId="u" enabled osEnabled onDirtyChange={vi.fn()} onOpenCustomer={open}/>);
    await waitFor(()=>expect(platform.showIncomingCalls).toHaveBeenCalledWith([expect.objectContaining({id:event.id})]));
    action(event.id,'customer',match.customer_id);
    await waitFor(()=>expect(open).toHaveBeenCalledTimes(1));
    expect(acknowledge).not.toHaveBeenCalled();
    open.mockResolvedValue(true);action(event.id,'customer',match.customer_id);
    await waitFor(()=>expect(acknowledge).toHaveBeenCalledWith(event.id));
  });
  it('opens only a matched customer from a native detail action and ignores an old scope', async () => {
    let action: (id: string, kind?: 'customer' | 'retry', customer?: string) => void = () => {};
    const open = vi.fn(async () => true);
    const platform = { showIncomingCalls: vi.fn(async () => {}), subscribeIncomingCallAction: async (handler: typeof action) => { action = handler; return () => {}; } } as unknown as Platform;
    const api = { listIncomingCalls: vi.fn().mockResolvedValueOnce({ items: [event], cursor: 'next' }).mockImplementation(pending) } as unknown as ApiClient;
    const props = { api, platform, organizationId: 'org', userId: 'user', enabled: true, osEnabled: false, onDirtyChange: vi.fn(), onOpenCustomer: open };
    const view = render(<IncomingCallAlerts {...props} />);
    await waitFor(() => expect(platform.showIncomingCalls).toHaveBeenCalledWith([expect.objectContaining({ id: event.id })]));
    action(event.id, 'customer', 'unknown'); expect(open).not.toHaveBeenCalled();
    action(event.id, 'customer', match.customer_id); expect(open).toHaveBeenCalledWith(match.customer_id);
    const old = action;
    view.rerender(<IncomingCallAlerts {...props} organizationId="another" />);
    old(event.id, 'customer', match.customer_id); expect(open).toHaveBeenCalledTimes(1);
  });
  it('uses the independent native window without a duplicate OS banner, and clears it on lock', async () => {
    const show = vi.fn(async () => {});
    const send = vi.fn(async () => {});
    let memo: (id: string) => void = () => {};
    const off = vi.fn();
    const platform = { showIncomingCalls: show, sendOsNotification: send, subscribeIncomingCallAction: async (handler: (id: string) => void) => { memo = handler; return off; } } as unknown as Platform;
    const api = { listIncomingCalls: vi.fn().mockResolvedValueOnce({ items: [event], cursor: 'next' }).mockImplementation(pending) } as unknown as ApiClient;
    const props = { api, platform, organizationId: 'org', userId: 'user', enabled: true, osEnabled: true, onDirtyChange: vi.fn() };
    const view = render(<IncomingCallAlerts {...props} />);
    await waitFor(() => expect(show).toHaveBeenCalledWith([expect.objectContaining({ id: event.id, title: '전화고객', phone: event.phone_e164, expiresAt: Date.parse(event.expires_at) })]));
    expect(send).not.toHaveBeenCalled();
    memo(event.id);
    expect(await screen.findByLabelText('상담 메모')).toBeInTheDocument();
    view.rerender(<IncomingCallAlerts {...props} enabled={false} />);
    await waitFor(() => expect(show).toHaveBeenLastCalledWith([]));
    expect(screen.getByLabelText('상담 메모')).toBeInTheDocument();
  });
  it('keeps the in-app card when the native window cannot open', async () => {
    const api = { listIncomingCalls: vi.fn().mockResolvedValueOnce({ items: [event], cursor: 'next' }).mockImplementation(pending) } as unknown as ApiClient;
    render(<IncomingCallAlerts api={api} organizationId="org" userId="user" enabled osEnabled={false} platform={{ showIncomingCalls: vi.fn().mockRejectedValue(new Error('native')) } as unknown as Platform} onDirtyChange={vi.fn()} />);
    expect(await screen.findByText('전화고객')).toBeInTheDocument();
  });
  it('shows a matched customer, seeds a memo without a new lookup and preserves failed memo input', async () => {
    const api = { listIncomingCalls: vi.fn().mockResolvedValueOnce({ items: [event], cursor: 'next' }).mockImplementation(pending), createMobilePhoneMemo: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as ApiClient;
    const send = vi.fn(async () => {});
    render(<IncomingCallAlerts api={api} organizationId="org" userId="user" enabled platform={{ sendOsNotification: send } as unknown as Platform} osEnabled onDirtyChange={vi.fn()} />);
    expect(await screen.findByText('전화고객')).toBeInTheDocument();
    await waitFor(() => expect(send).toHaveBeenCalledWith('고객 전화 수신', 'PC 프로그램에서 고객 정보를 확인하세요.'));
    fireEvent.click(screen.getByRole('button', { name: '메모 작성' }));
    expect(screen.getByLabelText('전화번호')).toHaveValue(match.phone_e164);
    fireEvent.change(screen.getByLabelText('상담 메모'), { target: { value: '예약 문의 메모' } });
    fireEvent.click(screen.getByRole('button', { name: '메모 저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('작성한 내용은 유지');
    expect(screen.getByLabelText('상담 메모')).toHaveValue('예약 문의 메모');
  });
  it('discards a previous organization response after switching scope', async () => {
    let finish: (value: unknown) => void = () => {};
    const api = { listIncomingCalls: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(pending) } as unknown as ApiClient;
    const props = { api, organizationId: 'old', userId: 'user', enabled: true, platform: {} as Platform, osEnabled: false, onDirtyChange: vi.fn() };
    const view = render(<IncomingCallAlerts {...props} />);
    view.rerender(<IncomingCallAlerts {...props} organizationId="new" />);
    finish({ items: [event], cursor: 'old' });
    await waitFor(() => expect(api.listIncomingCalls).toHaveBeenCalledWith('new', '', 8000));
    expect(screen.queryByText('전화고객')).not.toBeInTheDocument();
  });
  it('does not notify twice for retries and keeps an open memo while polling is suspended by the lock', async () => {
    const send = vi.fn(async () => {});
    const page = { items: [event], cursor: 'next' };
    const api = { listIncomingCalls: vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(page).mockImplementation(pending) } as unknown as ApiClient;
    const props = { api, organizationId: 'org', userId: 'user', enabled: true, platform: { sendOsNotification: send } as unknown as Platform, osEnabled: true, onDirtyChange: vi.fn() };
    const view = render(<IncomingCallAlerts {...props} />);
    await screen.findByText('전화고객');
    await waitFor(() => expect(api.listIncomingCalls).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '메모 작성' }));
    fireEvent.change(screen.getByLabelText('상담 메모'), { target: { value: '작성 중인 내용' } });
    view.rerender(<IncomingCallAlerts {...props} enabled={false} />);
    expect(screen.getByLabelText('상담 메모')).toHaveValue('작성 중인 내용');
    view.rerender(<IncomingCallAlerts {...props} />);
    expect(screen.getByLabelText('상담 메모')).toHaveValue('작성 중인 내용');
  });
});
