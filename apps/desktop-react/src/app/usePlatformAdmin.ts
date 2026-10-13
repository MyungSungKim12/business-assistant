import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';

/**
 * 플랫폼 관리자 여부(ADM-10). 로그인해 매장에 들어온 뒤 한 번 서버(/admin/me)에 확인하고,
 * 확인 전·실패·관리자 API 미설정이면 false 로 두어 '구독' 메뉴를 숨긴다. 결과는 ApiClient 가 세션 동안 재사용한다.
 */
export function usePlatformAdmin(api: Pick<ApiClient, 'isPlatformAdmin'> | Record<string, unknown>, enabled: boolean): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    const check = (api as Partial<Pick<ApiClient, 'isPlatformAdmin'>>).isPlatformAdmin;
    if (!enabled || typeof check !== 'function') { setAdmin(false); return undefined; }
    let current = true;
    check.call(api).then((value) => { if (current) setAdmin(value === true); }).catch(() => { if (current) setAdmin(false); });
    return () => { current = false; };
  }, [api, enabled]);
  return admin;
}
