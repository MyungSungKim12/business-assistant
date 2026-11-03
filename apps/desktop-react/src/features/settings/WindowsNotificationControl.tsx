import { useRef, useState } from 'react';
import type { Platform } from '../../platform/types';
import { usePreferences } from '../../store/preferences';

/** Explicit user opt-in for Windows banners; native caller popup is independent. */
export function WindowsNotificationControl({ platform, compact = false }: { platform: Platform; compact?: boolean }) {
  const enabled = usePreferences(state => state.desktopNotificationsEnabled);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const pending = useRef(false);
  if (platform.kind !== 'tauri' || !platform.requestOsNotificationPermission || !platform.sendOsNotification) return null;

  async function test() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setMessage(''); setError(false);
    const userId = usePreferences.getState().userId;
    try {
      if (!await platform.requestOsNotificationPermission!()) throw new Error('Windows 설정 → 시스템 → 알림에서 Business Assistant 알림과 배너를 허용해 주세요.');
      if (usePreferences.getState().userId !== userId) return;
      usePreferences.getState().setDesktopNotificationsEnabled(true);
      await platform.sendOsNotification!('Business Assistant 알림 테스트', '이 알림이 보이면 최소화·트레이 상태에서도 예약·할 일 배너 알림을 받을 수 있습니다.');
      setMessage('테스트 알림을 요청했습니다. 보이지 않으면 Windows 알림 배너·방해 금지 설정을 확인하세요.');
    } catch (cause) {
      setError(true);
      setMessage(cause instanceof Error ? cause.message : 'Windows 알림을 요청하지 못했습니다. 알림 설정을 확인하고 다시 시도하세요.');
      platform.log?.('WARN', 'Windows notification setup/test failed');
    } finally { pending.current = false; setBusy(false); }
  }

  if (compact && enabled) return null;
  return <div className="windows-notification-control">
    {!compact && <label className="settings-row">
      <span><strong>Windows 알림</strong><small>예약 임박·할 일을 바탕화면 배너로 알립니다. 앱 실행 중 최소화·트레이 상태에서도 동작합니다. 고객 전화는 이 설정과 별개로 전용 알림창에 표시합니다.</small></span>
      <input aria-label="Windows 알림" type="checkbox" checked={enabled} disabled={busy} onChange={event => { if (event.currentTarget.checked) void test(); else usePreferences.getState().setDesktopNotificationsEnabled(false); }} />
    </label>}
    <div className="settings-actions"><button type="button" disabled={busy} onClick={() => void test()}>{busy ? '알림 확인 중…' : enabled ? '테스트 알림 보내기' : 'Windows 알림 켜기'}</button></div>
    {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
  </div>;
}
