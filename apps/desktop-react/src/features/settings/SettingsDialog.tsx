import { useEffect, useState } from 'react';
import { Modal } from '@business-assistant/react-ui';
import type { Platform } from '../../platform/types';
export function SettingsDialog({ platform, onClose }: { platform: Platform; onClose: () => void }) {
  const [autostart, setAutostart] = useState(false);
  useEffect(() => { platform.autostart?.isEnabled().then(setAutostart).catch(() => undefined); }, [platform]);
  return <Modal title="환경 설정" onClose={onClose} size="sm"><div className="settings-list"><label><span><strong>Windows 시작 시 실행</strong><small>{platform.autostart ? '이 기기에서 자동으로 앱을 엽니다.' : '웹 미리보기에서는 사용할 수 없습니다.'}</small></span><input type="checkbox" disabled={!platform.autostart} checked={autostart} onChange={async (e) => { await platform.autostart?.setEnabled(e.target.checked); setAutostart(e.target.checked); }}/></label><div><span><strong>업데이트 확인</strong><small>{platform.checkUpdate ? '새 버전을 확인할 수 있습니다.' : '패키징 단계에서 지원 예정'}</small></span></div></div></Modal>;
}
