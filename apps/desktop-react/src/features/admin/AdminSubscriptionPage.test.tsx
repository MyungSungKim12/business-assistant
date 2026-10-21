import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { apiFailure, fakeApi } from '../appointment-resources/testApi';
import { AdminSubscriptionPage, toOffsetIso } from './index';

const ORG = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const OTHER = 'b9cc39fd-8e8c-4df8-a623-1f23a3a936bd';

function setup(handler: (body: Record<string, unknown>) => unknown = (body) => body) {
  const server = fakeApi((call) => call.path === '/admin/plans/storage-quotas'
    ? [{ plan_code: 'BASIC', plan_name: '베이직', quota_bytes: null }]
    : call.path === '/admin/plans/BASIC/storage-quota' && call.method === 'PATCH'
      ? { plan_code: 'BASIC', plan_name: '베이직', quota_bytes: (call.body as { quota_bytes: number | null }).quota_bytes }
      : handler((call.body ?? {}) as Record<string, unknown>));
  render(<><NoticeHost /><ConfirmDialog /><AdminSubscriptionPage api={server.api as never} organizationId={ORG} /></>);
  return server;
}
function fill(start = '2026-09-16T09:00', end = '') {
  fireEvent.change(screen.getByLabelText('시작 시각'), { target: { value: start } });
  if (end) fireEvent.change(screen.getByLabelText('종료 시각(선택)'), { target: { value: end } });
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: '구독 저장' }));

describe('AdminSubscriptionPage', () => {
  it('현재 조직 ID를 기본값으로 보여 준다', () => {
    setup();
    expect(screen.getByLabelText('대상 조직 ID')).toHaveValue(ORG);
  });

  it('확인 후 정규화한 값(대문자 플랜, 오프셋 ISO)으로 교체 요청을 보낸다', async () => {
    const { calls } = setup();
    fireEvent.change(screen.getByLabelText('플랜 코드'), { target: { value: '  basic  ' } });
    fireEvent.change(screen.getByLabelText('대상 조직 ID'), { target: { value: OTHER } });
    fill('2026-09-16T09:00', '2026-10-16T09:00');
    submit();
    expect(await screen.findByText(/구독을 BASIC \/ active/, { exact: false })).toBeInTheDocument();
    expect(calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '교체' }));
    await waitFor(() => expect(calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(1));
    const subscriptionCall = calls.find(call => call.path.endsWith('/subscription'))!;
    expect(subscriptionCall.method).toBe('POST');
    expect(subscriptionCall.path).toBe(`/admin/organizations/${OTHER}/subscription`);
    expect(subscriptionCall.body).toEqual({ plan_code: 'BASIC', status: 'active', starts_at: toOffsetIso('2026-09-16T09:00'), ends_at: toOffsetIso('2026-10-16T09:00') });
    expect((subscriptionCall.body as { starts_at: string }).starts_at).toMatch(/Z$/);
    expect((await screen.findAllByText(/구독을 저장했습니다/)).length).toBeGreaterThan(0);
  });

  it('확인에서 취소하면 보내지 않는다', async () => {
    const { calls } = setup();
    fill();
    submit();
    fireEvent.click(await screen.findByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '교체' })).not.toBeInTheDocument());
    expect(calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(0);
  });

  it.each([
    ['잘못된 조직 ID', () => fireEvent.change(screen.getByLabelText('대상 조직 ID'), { target: { value: 'abc' } }), '대상 조직 ID(UUID)를 확인하세요.'],
    ['빈 플랜 코드', () => fireEvent.change(screen.getByLabelText('플랜 코드'), { target: { value: '  ' } }), '플랜 코드를 입력하세요.'],
    ['시작 시각 없음', () => fireEvent.change(screen.getByLabelText('시작 시각'), { target: { value: '' } }), '시작 시각을 입력하세요.'],
    ['종료가 시작보다 빠름', () => fireEvent.change(screen.getByLabelText('종료 시각(선택)'), { target: { value: '2026-09-15T09:00' } }), '종료 시각은 시작 시각보다 뒤여야 합니다.'],
  ])('%s 은 서버로 보내지 않는다', async (_name, mutate, message) => {
    const { calls } = setup();
    fill();
    mutate();
    submit();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(calls.filter(call => call.path.endsWith('/subscription'))).toHaveLength(0);
  });

  it.each([
    [403, '플랫폼 관리자만 사용할 수 있습니다.'],
    [404, '조직을 찾을 수 없습니다.'],
    [422, '입력값을 확인하세요. 플랜 코드, 상태, 시작·종료 시각이 올바르지 않습니다.'],
    [503, '구독을 저장하지 못했습니다. 서버의 관리자 설정(서비스 키)을 확인하고 다시 시도하세요.'],
  ])('서버 %i 오류를 안내한다', async (status, message) => {
    setup(() => { throw apiFailure(status); });
    fill();
    submit();
    fireEvent.click(await screen.findByRole('button', { name: '교체' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('상태를 고를 수 있다', async () => {
    const { calls } = setup();
    fill();
    fireEvent.change(screen.getByLabelText('상태'), { target: { value: 'canceled' } });
    submit();
    fireEvent.click(await screen.findByRole('button', { name: '교체' }));
    await waitFor(() => expect(calls.find(call => call.path.endsWith('/subscription'))?.body).toMatchObject({ status: 'canceled', ends_at: null }));
  });

  it('미설정 플랜 용량은 빈 값으로 표시하고 확인 뒤 바이트 단위로 저장한다', async () => {
    const { calls } = setup();
    expect(await screen.findByLabelText('BASIC 저장 한도 GiB')).toHaveValue(null);
    fireEvent.change(screen.getByLabelText('BASIC 저장 한도 GiB'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'BASIC 한도 저장' }));
    fireEvent.click(await screen.findByRole('button', { name: '저장' }));
    await waitFor(() => expect(calls.find(call => call.path.endsWith('/BASIC/storage-quota'))?.body).toEqual({ quota_bytes: 8 * 1024 ** 3 }));
    expect(await screen.findByText('BASIC 요금제 용량을 저장했습니다.')).toBeInTheDocument();
  });
});
