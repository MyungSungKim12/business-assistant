import { useCallback, useEffect, useState } from 'react';
import type { Organization, Session } from '../api/schemas';
import { useSessionStore } from '../store/session';
import type { AppServices } from './services';

export type SessionPhase = 'restoring' | 'login' | 'organizations' | 'ready' | 'empty';

/** 세션 복원, 로그인, 매장 선택, 로그아웃의 흐름을 한곳에서 관리한다. */
export function useSessionFlow({ api }: AppServices) {
  const { setUser, selectOrganization, reset } = useSessionStore();
  const [phase, setPhase] = useState<SessionPhase>('restoring');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [error, setError] = useState('');

  const choose = useCallback(async (organization: Organization) => {
    try {
      selectOrganization(organization, await api.getEntitlements(organization.id));
      setPhase('ready');
    } catch (reason) {
      setError((reason as { status?: number }).status === 403 ? '이 매장을 볼 권한이 없습니다.' : '매장 정보를 불러오지 못했습니다.');
      setPhase('organizations');
    }
  }, [api, selectOrganization]);

  const continueSession = useCallback(async (session: Session) => {
    setUser(session.user);
    const items = await api.listOrganizations();
    setOrganizations(items);
    if (items.length === 0) setPhase('empty');
    else if (items.length === 1) await choose(items[0]);
    else setPhase('organizations');
  }, [api, choose, setUser]);

  useEffect(() => {
    let current = true;
    api.restoreSession()
      .then((result) => (current && result.authenticated ? continueSession(result.session) : current ? setPhase('login') : undefined))
      .catch(() => { if (current) setPhase('login'); });
    return () => { current = false; };
  }, [api, continueSession]);

  const login = useCallback(async (email: string, password: string) => {
    setError('');
    try {
      await continueSession(await api.login(email, password));
    } catch {
      setError('이메일과 비밀번호를 확인해 주세요.');
    }
  }, [api, continueSession]);

  const logout = useCallback(async () => {
    await api.logout();
    reset();
    setPhase('login');
  }, [api, reset]);

  return { phase, organizations, error, choose, login, logout };
}
