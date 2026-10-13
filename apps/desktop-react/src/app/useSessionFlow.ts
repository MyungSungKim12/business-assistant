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
  const [notice, setNotice] = useState('');

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

  const signUp = useCallback(async (email: string, password: string, displayName: string) => {
    setError(''); setNotice('');
    if (!api.signUp) { setError('이 환경에서는 회원가입을 지원하지 않습니다.'); return; }
    try {
      const result = await api.signUp(email, password, displayName);
      if (result.confirmationRequired) { setNotice('가입 확인 메일을 보냈습니다. 메일의 링크로 확인한 뒤 로그인해 주세요.'); return; }
      await continueSession(result.session);
    } catch {
      setError('가입하지 못했습니다. 입력값을 확인해 주세요. 이미 가입한 이메일일 수 있습니다.');
    }
  }, [api, continueSession]);

  /** 새 매장을 만들고 바로 그 매장으로 시작한다. 실패하면 입력은 화면에 남는다. */
  const createOrganization = useCallback(async (name: string, slug: string): Promise<boolean> => {
    setError('');
    if (!api.createOrganization) { setError('이 환경에서는 매장 만들기를 지원하지 않습니다.'); return false; }
    try {
      const created = await api.createOrganization(name, slug);
      setOrganizations((current) => [...current, created]);
      await choose(created);
      return true;
    } catch {
      setError('매장을 만들지 못했습니다. 매장 코드가 이미 사용 중일 수 있습니다.');
      return false;
    }
  }, [api, choose]);

  const logout = useCallback(async () => {
    await api.logout();
    reset();
    setPhase('login');
  }, [api, reset]);

  return { phase, organizations, error, notice, choose, login, signUp, createOrganization, logout };
}
