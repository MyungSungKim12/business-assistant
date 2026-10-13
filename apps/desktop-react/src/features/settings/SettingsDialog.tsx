import { useEffect, useState } from 'react';
import { Modal } from '@business-assistant/react-ui';
import { PrivacySecuritySettings } from './PrivacySecuritySettings';
import { UpdateSection } from './UpdateSection';
import type { Platform } from '../../platform/types';

export function SettingsDialog({ platform, onClose }: { platform: Platform; onClose: () => void }) {
  const [autostart, setAutostart] = useState(false);
  useEffect(() => { platform.autostart?.isEnabled().then(setAutostart).catch(() => undefined); }, [platform]);
  const toggleAutostart = async (enabled: boolean) => {
    await platform.autostart?.setEnabled(enabled);
    setAutostart(enabled);
  };
  return (
    <Modal title="환경 설정" onClose={onClose} size="sm">
      <div className="settings-list">
        <label>
          <span><strong>Windows 시작 시 실행</strong><small>{platform.autostart ? '이 기기에서 자동으로 앱을 엽니다.' : '웹 미리보기에서는 사용할 수 없습니다.'}</small></span>
          <input type="checkbox" disabled={!platform.autostart} checked={autostart} onChange={(event) => void toggleAutostart(event.target.checked)} />
        </label>
        <PrivacySecuritySettings />
        <UpdateSection platform={platform} />
      </div>
    </Modal>
  );
}
