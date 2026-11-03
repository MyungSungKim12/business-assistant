import {runInNewContext} from 'node:vm';
import {describe,it,expect,vi} from 'vitest';
import {recoveryScript} from './recovery-page.js';
function page(hash:string,fetcher=vi.fn(async()=>({ok:true,status:200,json:async()=>({password_changed:true,session_cleanup_pending:false})}))){
 let submit:((event:{preventDefault:()=>void})=>Promise<void>)|undefined;
 const status={textContent:''},button={disabled:false},form={hidden:false,password:{value:''},confirm:{value:''},reset:vi.fn(),addEventListener:(_name:string,listener:typeof submit)=>{submit=listener;}};
 const replaceState=vi.fn();runInNewContext(recoveryScript,{URLSearchParams,location:{hash,pathname:'/account/recovery'},history:{replaceState},document:{querySelector:(selector:string)=>selector==='form'?form:button,getElementById:()=>status},addEventListener:vi.fn(),fetch:fetcher});
 return {form,status,fetcher,replaceState,submit:()=>submit!({preventDefault:vi.fn()})};
}
describe('hosted recovery browser script',()=>{
 it('truthfully reports committed password and uncertain cleanup',async()=>{
  const p=page('#access_token=x&type=recovery',vi.fn(async()=>({ok:true,status:200,json:async()=>({password_changed:true,session_cleanup_pending:true})})));p.form.password.value=p.form.confirm.value='new-password';await p.submit();expect(p.status.textContent).toContain('비밀번호가 변경되었습니다');expect(p.status.textContent).toContain('로그아웃은 확인하지 못했습니다');
 });
 it('strips URL tokens immediately and refuses missing or confirmation-only links',()=>{for(const hash of ['', '#access_token=x&type=signup']){const p=page(hash);expect(p.replaceState).toHaveBeenCalledWith(null,'','/account/recovery');expect(p.form.hidden).toBe(true);expect(p.fetcher).not.toHaveBeenCalled();}});
 it('checks confirmation and keeps input on network failure, then completes on retry',async()=>{
  const fetcher=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ok:true,status:200,json:async()=>({password_changed:true,session_cleanup_pending:false})});const p=page('#access_token=secret&type=recovery',fetcher);
  p.form.password.value='long-password';p.form.confirm.value='mismatch';await p.submit();expect(fetcher).not.toHaveBeenCalled();p.form.confirm.value='long-password';await p.submit();expect(p.status.textContent).toContain('입력을 유지');expect(p.form.password.value).toBe('long-password');await p.submit();expect(p.form.hidden).toBe(true);expect(p.status.textContent).toContain('변경되었습니다');expect(fetcher).toHaveBeenLastCalledWith('/api/v1/auth/password',expect.objectContaining({headers:{Authorization:'Bearer secret','Content-Type':'application/json'}}));
 });
 it('shows expired-link state without clearing user draft',async()=>{const p=page('#access_token=expired&type=recovery',vi.fn(async()=>({ok:false,status:401,json:async()=>({password_changed:false,session_cleanup_pending:false})})));p.form.password.value=p.form.confirm.value='long-password';await p.submit();expect(p.status.textContent).toContain('만료');expect(p.form.hidden).toBe(false);});
});


