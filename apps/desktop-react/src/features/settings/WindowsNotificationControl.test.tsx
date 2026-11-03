import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Platform } from '../../platform/types';
import { usePreferences } from '../../store/preferences';
import { WindowsNotificationControl } from './WindowsNotificationControl';

describe('Windows notification setup', () => {
  beforeEach(() => { localStorage.clear(); usePreferences.getState().load('notification-user'); });
  it('enables only after permission, sends a test and preserves the preference', async () => {
    const permission = vi.fn(async () => true);
    const send = vi.fn(async () => {});
    render(<WindowsNotificationControl platform={{ kind: 'tauri', requestOsNotificationPermission: permission, sendOsNotification: send } as unknown as Platform} />);
    fireEvent.click(screen.getByRole('button', { name: 'Windows 알림 켜기' }));
    await waitFor(() => expect(usePreferences.getState().desktopNotificationsEnabled).toBe(true));
    expect(send).toHaveBeenCalledWith('Business Assistant 알림 테스트', '이 알림이 보이면 최소화·트레이 상태에서도 예약·할 일 배너 알림을 받을 수 있습니다.');
    fireEvent.click(screen.getByRole('button', { name: '테스트 알림 보내기' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    usePreferences.getState().load('notification-user');
    expect(usePreferences.getState().desktopNotificationsEnabled).toBe(true);
  });
  it('keeps notifications disabled and explains permission refusal', async () => {
    const send = vi.fn();
    render(<WindowsNotificationControl platform={{ kind: 'tauri', requestOsNotificationPermission: async () => false, sendOsNotification: send } as unknown as Platform} />);
    fireEvent.click(screen.getByRole('button', { name: 'Windows 알림 켜기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Windows 설정');
    expect(usePreferences.getState().desktopNotificationsEnabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
