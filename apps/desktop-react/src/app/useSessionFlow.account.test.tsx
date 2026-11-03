import {act,renderHook,waitFor} from '@testing-library/react';
import {describe,it,expect,vi} from 'vitest';
import {useSessionFlow} from './useSessionFlow';
import type {AppServices} from './services';
import {useSessionStore} from '../store/session';
describe('logout uncertainty notice',()=>{
 it('returns to login with honest server-unconfirmed notice after expired JWT logout',async()=>{
  const services={api:{restoreSession:async()=>({authenticated:false}),logout:vi.fn(async()=>{throw {status:401};})}} as unknown as AppServices;
  const {result}=renderHook(()=>useSessionFlow(services));await waitFor(()=>expect(result.current.phase).toBe('login'));
  useSessionStore.getState().setUser({user_id:'11111111-1111-4111-8111-111111111111',email:'a@example.com',display_name:null});
  await act(async()=>{await result.current.logout();});expect(result.current.phase).toBe('login');expect(useSessionStore.getState().user).toBeNull();expect(result.current.notice).toContain('이 기기에서 로그아웃');expect(result.current.notice).toContain('서버 세션 해제는 확인하지 못했습니다');
 });
});
