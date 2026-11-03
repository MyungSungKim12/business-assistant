import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { ApiClient } from '../../api/client';
import { PhoneMemoDialog } from './PhoneMemoDialog';

const customerId = 'c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const match = { customer_id: customerId, name: '김고객', phone: '010-1234-5678', phone_e164: '+821012345678' };
function api(overrides: Record<string, unknown> = {}) {
  return { identifyMobileCaller: vi.fn(async () => ({ phone_e164: match.phone_e164, matches: [match] })), createMobilePhoneMemo: vi.fn(async () => ({})), ...overrides } as never;
}

describe('PhoneMemoDialog', () => {
  it('protects the submitted durable memo and number while a deferred save is pending',async()=>{
    let resolve!:(value:unknown)=>void;const close=vi.fn();
    const respond=vi.fn(()=>new Promise(r=>{resolve=r;}));
    const client=api({getPhoneInboxRecord:vi.fn(async()=>({recipient_id:customerId,version:4})),respondPhoneInbox:respond}) as ApiClient;
    render(<PhoneMemoDialog api={client} organizationId="a9cc39fd-8e8c-4df8-a623-1f23a3a936bd" initialCall={{id:customerId,phone_e164:match.phone_e164,occurred_at:new Date().toISOString(),matches:[match]}} onClose={close}/>);
    fireEvent.change(screen.getByLabelText('상담 메모'),{target:{value:'전송할 메모'}});fireEvent.click(screen.getByRole('button',{name:'메모 저장'}));
    await waitFor(()=>expect(respond).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('상담 메모')).toBeDisabled();expect(screen.getByLabelText('전화번호')).toBeDisabled();expect(screen.getByRole('radio')).toBeDisabled();
    expect(screen.getByLabelText('상담 메모')).toHaveValue('전송할 메모');expect(close).not.toHaveBeenCalled();
    resolve({});await waitFor(()=>expect(close).toHaveBeenCalledOnce());
    expect(respond).toHaveBeenCalledWith(expect.any(String),customerId,expect.objectContaining({memo:'전송할 메모',expected_version:4}));
  });
  it('retries a durable history memo with the same version and operation and never duplicates the manual activity path',async()=>{
    let fail=true;const respond=vi.fn(async()=>{if(fail)throw new Error('offline');return {};});const close=vi.fn();
    const client=api({getPhoneInboxRecord:vi.fn(async()=>({recipient_id:customerId,version:4})),respondPhoneInbox:respond}) as ApiClient;
    render(<PhoneMemoDialog api={client} organizationId="a9cc39fd-8e8c-4df8-a623-1f23a3a936bd" initialCall={{id:customerId,phone_e164:match.phone_e164,occurred_at:new Date().toISOString(),matches:[match]}} onClose={close}/>);
    fireEvent.change(screen.getByLabelText('상담 메모'),{target:{value:'번호가 바뀌어도 당시 고객에게'}});fireEvent.click(screen.getByRole('button',{name:'메모 저장'}));await screen.findByRole('alert');
    fail=false;fireEvent.click(screen.getByRole('button',{name:'메모 저장'}));await waitFor(()=>expect(close).toHaveBeenCalled());
    expect(respond.mock.calls[0]).toEqual(respond.mock.calls[1]);expect(client.createMobilePhoneMemo).not.toHaveBeenCalled();expect(client.getPhoneInboxRecord).toHaveBeenCalledTimes(1);
  });
  it('looks up exact caller and saves a memo to the selected customer', async () => {
    const close = vi.fn(); const client = api() as ApiClient;
    render(<PhoneMemoDialog api={client} organizationId="a9cc39fd-8e8c-4df8-a623-1f23a3a936bd" onClose={close} />);
    fireEvent.change(screen.getByLabelText('전화번호'), { target: { value: '010-1234-5678' } });
    fireEvent.click(screen.getByRole('button', { name: '고객 확인' }));
    expect(await screen.findByText('김고객')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('상담 메모'), { target: { value: '다음 주 예약 문의' } });
    fireEvent.click(screen.getByRole('button', { name: '메모 저장' }));
    await waitFor(() => expect(client.createMobilePhoneMemo).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ customer_id: customerId, phone: '010-1234-5678', memo: '다음 주 예약 문의' })));
    await waitFor(() => expect(close).toHaveBeenCalled());
  });

  it('reports when the number has no exact customer match', async () => {
    const client = api({ identifyMobileCaller: vi.fn(async () => ({ phone_e164: match.phone_e164, matches: [] })) });
    render(<PhoneMemoDialog api={client} organizationId="a9cc39fd-8e8c-4df8-a623-1f23a3a936bd" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('전화번호'), { target: { value: '010-1234-5678' } });
    fireEvent.click(screen.getByRole('button', { name: '고객 확인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('일치하는 번호가 없습니다');
    expect(screen.getByLabelText('전화번호')).toHaveValue('010-1234-5678');
  });

  it('keeps the memo draft and matched customer when the network save fails', async () => {
    const client = api({ createMobilePhoneMemo: vi.fn(async () => { throw new Error('offline'); }) }) as ApiClient;
    render(<PhoneMemoDialog api={client} organizationId="a9cc39fd-8e8c-4df8-a623-1f23a3a936bd" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('전화번호'), { target: { value: '010-1234-5678' } });
    fireEvent.click(screen.getByRole('button', { name: '고객 확인' }));
    await screen.findByText('김고객');
    fireEvent.change(screen.getByLabelText('상담 메모'), { target: { value: '다음 주 예약 문의' } });
    fireEvent.click(screen.getByRole('button', { name: '메모 저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('작성한 내용은 유지');
    expect(screen.getByLabelText('상담 메모')).toHaveValue('다음 주 예약 문의');
  });
});
