import { useEffect, useRef } from 'react';
import { confirm } from '@business-assistant/react-ui';
import type { Platform } from '../platform/types';

interface TrayActionOptions {
  /** 로그인한 상태인지. 아니면 트레이의 로그아웃 요청은 무시한다. */
  signedIn: boolean;
  logout: () => Promise<void>;
  beforeLeave?: () => Promise<boolean>;
}

/**
 * 트레이 메뉴의 로그아웃·종료 요청을 받아 앱 안의 버튼과 같은 확인 창을 거쳐 처리한다.
 * 구독은 한 번만 하고 최신 상태는 ref로 읽어, 화면 전환 때마다 이벤트를 다시 걸지 않는다.
 */
export function useTrayActions(platform: Platform, { signedIn, logout, beforeLeave }: TrayActionOptions) {
  const latest = useRef({ signedIn, logout, beforeLeave });
  latest.current = { signedIn, logout, beforeLeave };

  useEffect(() => {
    if (!platform.subscribeTray) return undefined;
    let release: (() => void) | undefined;
    let disposed = false;
    void platform.subscribeTray(async (action) => {
      if (latest.current.beforeLeave && !(await latest.current.beforeLeave())) return;
      if (action === 'logout') {
        if (!latest.current.signedIn) return;
        if (await confirm({ title: '로그아웃', message: '로그아웃하시겠습니까?', confirmLabel: '로그아웃' })) await latest.current.logout();
        return;
      }
      if (await confirm({ title: '종료', message: 'Business Assistant를 종료하시겠습니까?', confirmLabel: '종료', tone: 'danger' })) await platform.exitApp?.();
    }).then((off) => { if (disposed) off(); else release = off; });
    return () => { disposed = true; release?.(); };
  }, [platform]);
}
