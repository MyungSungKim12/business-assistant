import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { CustomerRetentionDialog } from './CustomerRetentionDialog';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const customerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeApi() {
  return {
    getCustomerRetentionPolicy: vi.fn(async () => ({ policy: null, purge_enabled: false, reason: '파기 실행은 아직 잠겨 있습니다.' })),
    saveCustomerRetentionPolicy: vi.fn(async (o: string, input: object) => ({ organization_id: o, ...input, version: 1, updated_by: customerId, updated_at: '2026-10-21T00:00:00Z' })),
    getCustomerRetentionStatus: vi.fn(async () => ({ relationship_ended_at: null, active_hold: null })),
    setCustomerRelationshipEnd: vi.fn(async () => ({ relationship_ended_at: '2026-10-21T00:00:00Z' })),
    setCustomerLegalHold: vi.fn(async () => ({ active: true })),
  } as unknown as ApiClient;
}

describe('CustomerRetentionDialog', () => {
  it('keeps every unconfigured period blank, explains purge is locked, and saves explicit policy values', async () => {
    const api = makeApi();
    render(<CustomerRetentionDialog api={api} organizationId={organizationId} customerId={customerId} onClose={() => undefined} />);
    expect(await screen.findByText(/파기 실행은 아직 잠겨 있습니다/)).toBeTruthy();
    const profile = await screen.findByLabelText('고객 프로필 보유기간(일)') as HTMLInputElement;
    expect(profile.value).toBe('');
    fireEvent.change(profile, { target: { value: '365' } });
    fireEvent.click(screen.getByRole('button', { name: '보유기간 저장' }));
    await waitFor(() => expect(api.saveCustomerRetentionPolicy).toHaveBeenCalledWith(organizationId, expect.objectContaining({ profile_days: 365, sensitive_notes_days: null })));
    expect(screen.getByText(/미설정 항목은 계속 파기를 차단/)).toBeTruthy();
  });

  it('requires a reason for a legal hold and relationship closure and refreshes the visible state', async () => {
    const api = makeApi();
    render(<CustomerRetentionDialog api={api} organizationId={organizationId} customerId={customerId} onClose={() => undefined} />);
    await screen.findByText(/파기 실행은 아직 잠겨 있습니다/);
    fireEvent.change(screen.getByLabelText('보류 사유'), { target: { value: '분쟁 처리 중' } });
    fireEvent.click(screen.getByRole('button', { name: '법적 보류 설정' }));
    await waitFor(() => expect(api.setCustomerLegalHold).toHaveBeenCalledWith(organizationId, customerId, true, '분쟁 처리 중'));
    fireEvent.change(screen.getByLabelText('관계 종료 사유'), { target: { value: '이용 종료 요청' } });
    fireEvent.click(screen.getByRole('button', { name: '관계 종료 기록' }));
    await waitFor(() => expect(api.setCustomerRelationshipEnd).toHaveBeenCalledWith(organizationId, customerId, expect.any(String), '이용 종료 요청'));
  });
});
