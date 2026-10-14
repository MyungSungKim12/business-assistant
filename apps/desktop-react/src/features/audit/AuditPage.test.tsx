import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { AuditPage } from './AuditPage';

const ORG = '22222222-2222-4222-8222-222222222222';
const row = (id: string, action = 'customer.delete') => ({
  id, organization_id: ORG, actor_id: '11111111-1111-4111-8111-111111111111', action,
  target_type: 'customer', target_id: '33333333-3333-4333-8333-333333333333',
  metadata: { archived: true }, request_id: 'request-1', ip: null, source: 'api_user', created_at: '2026-10-14T01:00:00Z',
});

describe('AuditPage', () => {
  it('loads events, applies filters, and follows the next cursor page', async () => {
    const listAuditEvents = vi.fn()
      .mockResolvedValueOnce({ items: [row('44444444-4444-4444-8444-444444444444')], next_cursor: 'cursor-2' })
      .mockResolvedValueOnce({ items: [row('44444444-4444-4444-8444-444444444444')], next_cursor: 'cursor-2' })
      .mockResolvedValueOnce({ items: [row('55555555-5555-4555-8555-555555555555', 'sale.refund')], next_cursor: null });
    const api = { listAuditEvents } as unknown as ApiClient;
    render(<AuditPage api={api} organizationId={ORG} />);

    expect(await screen.findByText('customer.delete')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('시작일'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('종료일'), { target: { value: '2026-10-14' } });
    fireEvent.change(screen.getByLabelText('작업 코드'), { target: { value: 'sale.refund' } });
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(listAuditEvents).toHaveBeenCalledTimes(2));
    expect(listAuditEvents).toHaveBeenLastCalledWith(ORG, {
      from: '2026-10-01T00:00:00.000+09:00', to: '2026-10-14T23:59:59.999+09:00', action: 'sale.refund', limit: 50,
    });
    expect(await screen.findByText('customer.delete')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다음 페이지' }));
    await waitFor(() => expect(listAuditEvents).toHaveBeenCalledTimes(3));
    expect(listAuditEvents).toHaveBeenLastCalledWith(ORG, expect.objectContaining({ cursor: 'cursor-2' }));
    expect(await screen.findByText('sale.refund')).toBeInTheDocument();
  });

  it('retries a failed request without losing the action filter', async () => {
    const listAuditEvents = vi.fn().mockResolvedValueOnce({ items: [], next_cursor: null }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [], next_cursor: null });
    const api = { listAuditEvents } as unknown as ApiClient;
    render(<AuditPage api={api} organizationId={ORG} />);
    await screen.findByText('감사 기록이 없습니다.');
    fireEvent.change(screen.getByLabelText('작업 코드'), { target: { value: 'member.role_change' } });
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('감사 로그를 불러오지 못했습니다.');
    expect(screen.queryByText('감사 기록이 없습니다.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(listAuditEvents).toHaveBeenCalledTimes(3));
    expect(listAuditEvents).toHaveBeenLastCalledWith(ORG, expect.objectContaining({ action: 'member.role_change' }));
  });

  it('clears the previous organization records on organization change', async () => {
    const listAuditEvents = vi.fn().mockResolvedValueOnce({ items: [row('44444444-4444-4444-8444-444444444444')], next_cursor: null })
      .mockResolvedValueOnce({ items: [], next_cursor: null });
    const api = { listAuditEvents } as unknown as ApiClient;
    const view = render(<AuditPage api={api} organizationId={ORG} />);
    expect(await screen.findByText('customer.delete')).toBeInTheDocument();
    view.rerender(<AuditPage api={api} organizationId="66666666-6666-4666-8666-666666666666" />);
    await waitFor(() => expect(screen.getByText('감사 기록이 없습니다.')).toBeInTheDocument());
    expect(screen.queryByText('customer.delete')).not.toBeInTheDocument();
  });
});
