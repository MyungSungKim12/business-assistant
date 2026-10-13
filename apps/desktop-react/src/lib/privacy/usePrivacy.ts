import { useMemo } from 'react';
import { usePreferences } from '../../store/preferences';
import { maskEmail, maskPhone } from './mask';

export interface Privacy {
  /** 가려서 표시 옵션이 켜져 있는지 */
  masked: boolean;
  /** 옵션이 켜져 있으면 전화번호를 가려서, 꺼져 있으면 그대로 돌려준다. */
  phone(value: string | null | undefined): string;
  email(value: string | null | undefined): string;
}

/** 현재 사용자의 개인정보 표시 옵션(SEC-07)을 반영하는 표시 함수. 화면에서는 전화번호·이메일을 이 함수로 감싸 출력한다. */
export function usePrivacy(): Privacy {
  const masked = usePreferences((state) => state.maskPhone);
  return useMemo<Privacy>(() => ({
    masked,
    phone: (value) => (masked ? maskPhone(value) : value ?? ''),
    email: (value) => (masked ? maskEmail(value) : value ?? ''),
  }), [masked]);
}
