import { useEffect, useState } from 'react';
import { Modal } from '@business-assistant/react-ui';
import { AppearanceSettings } from './AppearanceSettings';
import { PrivacySecuritySettings } from './PrivacySecuritySettings';
import { UpdateSection } from './UpdateSection';
import type { Platform } from '../../platform/types';
import type {AppApi} from '../../app/services';
import {AccountSessions} from './AccountSessions';
import {PhoneRetentionStatus} from './PhoneRetentionStatus';

export function SettingsDialog({ platform, onClose,api,onSignedOut,beforeLeave }: { platform: Platform; onClose: () => void;api?:AppApi;onSignedOut?:()=>Promise<void>;beforeLeave?:()=>Promise<boolean> }) {
  const [autostart, setAutostart] = useState(false);
  useEffect(() => { platform.autostart?.isEnabled().then(setAutostart).catch(() => undefined); }, [platform]);
  const toggleAutostart = async (enabled: boolean) => {
    await platform.autostart?.setEnabled(enabled);
    setAutostart(enabled);
  };
  return (
    <Modal title="환경 설정" onClose={onClose} size="md">
      <div className="settings-list">
        <label>
          <span><strong>Windows 시작 시 실행</strong><small>{platform.autostart ? '이 기기에서 자동으로 앱을 엽니다.' : '웹 미리보기에서는 사용할 수 없습니다.'}</small></span>
          <input type="checkbox" disabled={!platform.autostart} checked={autostart} onChange={(event) => void toggleAutostart(event.target.checked)} />
        </label>
        <AppearanceSettings platform={platform} />
        <PrivacySecuritySettings />
        {api&&<PhoneRetentionStatus api={api}/>}
        {api?.listAccountSessions&&api.revokeAccountSessions&&onSignedOut&&<AccountSessions api={api} onSignedOut={onSignedOut} beforeLeave={beforeLeave}/>}
        <UpdateSection platform={platform} />
      </div>
    </Modal>
  );
}
