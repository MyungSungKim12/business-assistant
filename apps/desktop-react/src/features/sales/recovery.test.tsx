import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { useSessionStore } from '../../store/session';
import { adoptLegacyRecovery, loadRecovery, recoveryKey, useRecoverableOperation, useRecoveryKey } from './recovery';
import { network, ORG, VISIT } from './testkit';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const signIn = (id: string | null) => useSessionStore.setState({ user: id ? { user_id: id, email: `${id}@example.com`, display_name: null } : null });
const validate = (value: unknown) => (typeof value === 'object' && value !== null && 'operation_id' in value ? (value as { operation_id: string }) : null);

function useOperation(execute: (payload: { operation_id: string }) => Promise<string>, visit = VISIT) {
  const recovery = useRecoveryKey('payment', ORG, visit);
  return useRecoverableOperation<{ operation_id: string }, string>({ ...recovery, validate, execute, onSuccess: () => undefined, rejected: '거절', unconfirmed: '미확인' });
}

describe('복구 키', () => {
  beforeEach(() => { window.localStorage.clear(); signIn(null); });

  it('사용자 ID가 있으면 키에 넣고, 없으면 예전 형식을 쓴다', () => {
    expect(recoveryKey('payment', ORG, VISIT)).toBe(`ba.sales.recovery.payment.${ORG}.${VISIT}`);
    expect(recoveryKey('refund', ORG, VISIT, USER_A)).toBe(`ba.sales.recovery.refund.${USER_A}.${ORG}.${VISIT}`);
    expect(recoveryKey('return', ORG, VISIT, null)).toBe(`ba.sales.recovery.return.${ORG}.${VISIT}`);
  });

  it('로그인한 사용자에 따라 키가 바뀐다', () => {
    signIn(USER_A);
    const { result, rerender } = renderHook(() => useRecoveryKey('payment', ORG, VISIT));
    expect(result.current.key).toBe(`ba.sales.recovery.payment.${USER_A}.${ORG}.${VISIT}`);
    expect(result.current.legacyKey).toBe(`ba.sales.recovery.payment.${ORG}.${VISIT}`);
    act(() => signIn(USER_B));
    rerender();
    expect(result.current.key).toBe(`ba.sales.recovery.payment.${USER_B}.${ORG}.${VISIT}`);
  });

  it('예전 키의 미확인 요청은 사용자 키가 비어 있을 때만 한 번 이어받는다', () => {
    const legacy = recoveryKey('payment', ORG, VISIT);
    const scoped = recoveryKey('payment', ORG, VISIT, USER_A);
    window.localStorage.setItem(legacy, JSON.stringify({ operation_id: 'old' }));
    expect(adoptLegacyRecovery(scoped, legacy)).toBe(true);
    expect(window.localStorage.getItem(legacy)).toBeNull();
    expect(loadRecovery(scoped, validate)).toEqual({ status: 'pending', payload: { operation_id: 'old' } });
    window.localStorage.setItem(legacy, JSON.stringify({ operation_id: 'newer-legacy' }));
    expect(adoptLegacyRecovery(scoped, legacy)).toBe(false);
    expect(window.localStorage.getItem(legacy)).not.toBeNull();
    expect(adoptLegacyRecovery(legacy, legacy)).toBe(false);
    expect(adoptLegacyRecovery(recoveryKey('payment', ORG, VISIT, USER_B), recoveryKey('refund', ORG, VISIT))).toBe(false);
  });
});

describe('미확인 요청 복구(앱 재시작·계정 전환)', () => {
  beforeEach(() => { window.localStorage.clear(); signIn(USER_A); });

  it('결과를 알 수 없는 요청은 저장소에 남아 다시 열어도(재시작) 복구된다', async () => {
    const execute = vi.fn().mockRejectedValue(network());
    const first = renderHook(() => useOperation(execute));
    await act(async () => { await first.result.current.submit({ operation_id: 'op-1' }); });
    expect(first.result.current.message).toBe('미확인');
    expect(window.localStorage.getItem(recoveryKey('payment', ORG, VISIT, USER_A))).toContain('op-1');
    first.unmount();

    const restarted = renderHook(() => useOperation(execute));
    expect(restarted.result.current.pending).toEqual({ operation_id: 'op-1' });
    execute.mockResolvedValueOnce('ok');
    await act(async () => { restarted.result.current.retry(); });
    await waitFor(() => expect(restarted.result.current.pending).toBeNull());
    expect(execute).toHaveBeenLastCalledWith({ operation_id: 'op-1' });
    expect(window.localStorage.getItem(recoveryKey('payment', ORG, VISIT, USER_A))).toBeNull();
  });

  it('다른 계정으로 로그인하면 이전 사용자의 미확인 요청이 보이지 않는다', async () => {
    const execute = vi.fn().mockRejectedValue(network());
    const first = renderHook(() => useOperation(execute));
    await act(async () => { await first.result.current.submit({ operation_id: 'op-a' }); });
    first.unmount();

    act(() => signIn(USER_B));
    const other = renderHook(() => useOperation(execute));
    expect(other.result.current.pending).toBeNull();
    expect(other.result.current.invalid).toBe(false);
    expect(window.localStorage.getItem(recoveryKey('payment', ORG, VISIT, USER_A))).toContain('op-a');

    act(() => signIn(USER_A));
    const back = renderHook(() => useOperation(execute));
    expect(back.result.current.pending).toEqual({ operation_id: 'op-a' });
  });

  it('방문마다 따로 보관한다', async () => {
    const execute = vi.fn().mockRejectedValue(network());
    const first = renderHook(() => useOperation(execute));
    await act(async () => { await first.result.current.submit({ operation_id: 'op-visit' }); });
    const otherVisit = renderHook(() => useOperation(execute, '77777777-7777-4777-8777-777777777778'));
    expect(otherVisit.result.current.pending).toBeNull();
  });

  it('업그레이드 직전에 남은 예전 키의 요청을 현재 사용자가 이어받는다', () => {
    window.localStorage.setItem(recoveryKey('payment', ORG, VISIT), JSON.stringify({ operation_id: 'legacy' }));
    const { result } = renderHook(() => useOperation(vi.fn()));
    expect(result.current.pending).toEqual({ operation_id: 'legacy' });
    expect(window.localStorage.getItem(recoveryKey('payment', ORG, VISIT))).toBeNull();
    expect(window.localStorage.getItem(recoveryKey('payment', ORG, VISIT, USER_A))).toContain('legacy');
  });

  it('세션 사용자를 알 수 없으면 예전 키로 동작한다(기존 동작 유지)', async () => {
    signIn(null);
    const execute = vi.fn().mockRejectedValue(network());
    const { result } = renderHook(() => useOperation(execute));
    await act(async () => { await result.current.submit({ operation_id: 'op-x' }); });
    expect(window.localStorage.getItem(recoveryKey('payment', ORG, VISIT))).toContain('op-x');
  });

  it('월 마감으로 거절되면 서버 안내 문구를 보여 주고 저장된 요청을 지운다', async () => {
    const notice = '마감된 달의 거래는 등록·수정(보관 포함)할 수 없습니다. 관리자가 월 마감을 재오픈한 뒤 다시 시도하세요.';
    const execute = vi.fn().mockRejectedValue(new ApiError(409, 'FINANCE_MONTH_CLOSED', notice, false));
    const { result } = renderHook(() => useOperation(execute));
    await act(async () => { await result.current.submit({ operation_id: 'op-closed' }); });
    expect(result.current.message).toBe(notice);
    expect(result.current.pending).toBeNull();
    expect(window.localStorage.getItem(recoveryKey('payment', ORG, VISIT, USER_A))).toBeNull();
  });

  it('다른 확정 거절은 기존 문구를 쓴다', async () => {
    const execute = vi.fn().mockRejectedValue(new ApiError(409, 'HTTP_409', 'conflict', false));
    const { result } = renderHook(() => useOperation(execute));
    await act(async () => { await result.current.submit({ operation_id: 'op-conflict' }); });
    expect(result.current.message).toBe('거절');
  });
});
