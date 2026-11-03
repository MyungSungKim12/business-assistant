import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {describe,it,expect,vi} from 'vitest';
import {AccountSessions} from './AccountSessions';
import {LoginView} from '../auth/LoginView';
import type {AppApi} from '../../app/services';
describe('account controls',()=>{
 it('keeps email on failed recovery then supports resend',async()=>{
  const send=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);render(<LoginView onLogin={vi.fn()} onAccountEmail={send}/>);
  fireEvent.change(screen.getByLabelText('이메일'),{target:{value:'a@example.com'}});fireEvent.click(screen.getByText('비밀번호 찾기'));
  await screen.findByText('메일을 요청하지 못했습니다. 잠시 후 다시 시도해 주세요.');expect(screen.getByLabelText('이메일')).toHaveValue('a@example.com');fireEvent.click(screen.getByText('확인 메일 재전송'));await waitFor(()=>expect(send).toHaveBeenLastCalledWith('a@example.com','signup'));
 });
 it('shows real session fallback and preserves list after failed revoke',async()=>{
  const revoke=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({current_revoked:true});const signedOut=vi.fn(async()=>{});
  const api={listAccountSessions:vi.fn(async()=>({current_session_id:'a',items:[{session_id:'a',created_at:'2026-11-02T00:00:00Z',last_active_at:null,user_agent:null,is_current:true}],total:1,next_cursor:null})),revokeAccountSessions:revoke} as unknown as AppApi;
  render(<AccountSessions api={api} onSignedOut={signedOut}/>);await screen.findByText('알 수 없는 기기 (현재 세션)');
  fireEvent.click(screen.getByText('이 세션 로그아웃'));await screen.findByRole('alert');expect(signedOut).not.toHaveBeenCalled();fireEvent.click(screen.getByText('모든 기기 로그아웃'));await waitFor(()=>expect(signedOut).toHaveBeenCalledOnce());expect(revoke).toHaveBeenLastCalledWith(null);
 });
 it('honors draft cancellation before current/all logout',async()=>{
  const revoke=vi.fn();render(<AccountSessions api={{listAccountSessions:async()=>({current_session_id:'a',items:[],total:0,next_cursor:null}),revokeAccountSessions:revoke} as unknown as AppApi} beforeLeave={async()=>false} onSignedOut={vi.fn()}/>);
  await waitFor(()=>expect(screen.getByText('모든 기기 로그아웃')).not.toBeDisabled());fireEvent.click(screen.getByText('모든 기기 로그아웃'));await waitFor(()=>expect(revoke).not.toHaveBeenCalled());
 });
});
