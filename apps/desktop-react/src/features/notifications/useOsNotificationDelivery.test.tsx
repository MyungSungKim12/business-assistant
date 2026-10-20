import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Platform } from '../../platform/types';
import type { NotificationItem } from './notificationModel';
import { osNotificationStorageKey, useOsNotificationDelivery } from './osNotificationDelivery';

const pastTask = (id: string): NotificationItem => ({
  id, kind: 'task', title: `민감한 할 일 ${id}`, detail: '기한 지남', urgent: true,
  menu: 'tasks', sortKey: `2-${id}`, osNotifyAt: '2026-10-16T02:00:00.000Z',
});

function setupPlatform() {
  return {
    kind: 'tauri', apiBase: 'https://example.test', tokenStore: { load: vi.fn(), save: vi.fn(), clear: vi.fn() },
    request: vi.fn(), uploadBinary: vi.fn(), downloadBinary: vi.fn(), subscribeConnection: vi.fn(),
    log: vi.fn(),
    sendOsNotification: vi.fn(async () => undefined),
  } as unknown as Platform;
}

beforeEach(() => localStorage.clear());

describe('useOsNotificationDelivery', () => {
  it('첫 동기화 때는 과거 알림을 띄우지 않고 이후 새 항목은 한 번만 알린다', async () => {
    const platform = setupPlatform();
    const options = { items: [pastTask('old')], ready: false, enabled: true, userId: 'user-1', organizationId: 'org-1', platform };
    const { rerender } = renderHook((props) => useOsNotificationDelivery(props), { initialProps: options });

    rerender({ ...options, ready: true });
    expect(platform.sendOsNotification).not.toHaveBeenCalled();
    const next = { ...options, ready: true, items: [pastTask('old'), pastTask('new')] };
    rerender(next);
    await waitFor(() => expect(platform.sendOsNotification).toHaveBeenCalledTimes(1));
    expect(platform.sendOsNotification).toHaveBeenCalledWith('할 일 기한', '마감 시각이 되었습니다. 앱에서 확인하세요.');
    rerender(next);
    await act(async () => Promise.resolve());
    expect(platform.sendOsNotification).toHaveBeenCalledTimes(1);
  });

  it('매장 전환 후 이전 매장의 현재 알림을 새 매장의 알림처럼 보내지 않는다', () => {
    const platform = setupPlatform();
    const initial = { items: [pastTask('old-store')], ready: true, enabled: true, userId: 'user-1', organizationId: 'org-1', platform };
    const { rerender } = renderHook((props) => useOsNotificationDelivery(props), { initialProps: initial });
    rerender({ ...initial, organizationId: 'org-2' });

    expect(platform.sendOsNotification).not.toHaveBeenCalled();
    expect(localStorage.getItem(osNotificationStorageKey('user-1', 'org-2'))).toContain('old-store');
  });

  it('OS 전달에 실패하면 다음 목록 갱신 때 재시도한다', async () => {
    const platform = setupPlatform();
    vi.mocked(platform.sendOsNotification!).mockRejectedValueOnce(new Error('알림 권한 변경'));
    const options = { items: [pastTask('baseline')], ready: false, enabled: true, userId: 'user-1', organizationId: 'org-1', platform };
    const { rerender } = renderHook((props) => useOsNotificationDelivery(props), { initialProps: options });
    rerender({ ...options, ready: true });
    rerender({ ...options, ready: true, items: [...options.items, pastTask('retry-me')] });
    await waitFor(() => expect(platform.log).toHaveBeenCalled());

    rerender({ ...options, ready: true, items: [...options.items, pastTask('retry-me')] });
    await waitFor(() => expect(platform.sendOsNotification).toHaveBeenCalledTimes(2));
  });
});
