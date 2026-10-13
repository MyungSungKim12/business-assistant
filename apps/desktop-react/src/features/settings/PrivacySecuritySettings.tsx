import { Select } from '@business-assistant/react-ui';
import { IDLE_LOCK_CHOICES, usePreferences, type IdleLockMinutes } from '../../store/preferences';

const LOCK_OPTIONS = IDLE_LOCK_CHOICES.map((minutes) => ({ value: String(minutes), label: minutes === 0 ? '끔' : `${minutes}분` }));

/** 개인정보 표시(SEC-07)와 유휴 자동 잠금(SEC-08) 설정. 값은 로그인한 사용자별로 이 기기에 저장된다. */
export function PrivacySecuritySettings() {
  const maskPhone = usePreferences((state) => state.maskPhone);
  const idleLockMinutes = usePreferences((state) => state.idleLockMinutes);
  const setMaskPhone = usePreferences((state) => state.setMaskPhone);
  const setIdleLockMinutes = usePreferences((state) => state.setIdleLockMinutes);
  return (
    <>
      <label>
        <span><strong>전화번호 가려서 표시</strong><small>전화번호 가운데 자리와 이메일 일부를 *로 가립니다(이 기기·이 계정).</small></span>
        <input type="checkbox" checked={maskPhone} onChange={(event) => setMaskPhone(event.currentTarget.checked)} />
      </label>
      <label>
        <span><strong>자동 잠금</strong><small>입력이 없으면 화면을 잠그고, 비밀번호를 다시 입력해야 풀립니다.</small></span>
        <Select<string> aria-label="자동 잠금 시간" value={String(idleLockMinutes)} options={LOCK_OPTIONS} onChange={(value) => setIdleLockMinutes(Number(value) as IdleLockMinutes)} />
      </label>
    </>
  );
}
