import type {FastifyInstance} from 'fastify';

export const recoveryScript = `(()=>{
 'use strict';
 const fragment=new URLSearchParams(location.hash.slice(1));
 history.replaceState(null,'',location.pathname);
 let token=fragment.get('access_token');const type=fragment.get('type');fragment.forEach((_,key)=>fragment.delete(key));
 const form=document.querySelector('form'),status=document.getElementById('status'),submit=document.querySelector('button');
 if(!token||type!=='recovery'){token=null;form.hidden=true;status.textContent=type==='signup'?'이메일 확인이 완료되었습니다. 앱에서 로그인해 주세요.':'복구 링크가 없거나 만료되었습니다. 앱에서 복구 메일을 다시 요청해 주세요.';return;}
 let busy=false,complete=false;
 addEventListener('beforeunload',event=>{if(!complete&&(busy||form.password.value||form.confirm.value)){event.preventDefault();event.returnValue='';}});
 form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;
  const password=form.password.value;
  if(password.length<8||password.length>200||password!==form.confirm.value){status.textContent='8~200자의 비밀번호와 동일한 확인 값을 입력해 주세요.';return;}
  busy=true;submit.disabled=true;status.textContent='변경 중…';
  try{const response=await fetch('/api/v1/auth/password',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({password})});
   if(!response.ok){status.textContent=response.status===401?'복구 링크가 만료되었습니다. 앱에서 다시 요청해 주세요.':response.status===422?'기존 비밀번호와 다른 새 비밀번호를 사용하고 비밀번호 보안 조건을 확인해 주세요.':'변경 결과를 확인하지 못했습니다. 변경되었을 수 있으므로 새 비밀번호로 로그인을 확인한 뒤 다시 요청해 주세요.';return;}
   const result=await response.json();
   if(result.password_changed!==true)throw new Error('Unknown result');
   token=null;complete=true;form.reset();form.hidden=true;status.textContent=result.session_cleanup_pending?'비밀번호가 변경되었습니다. 다른 기기 로그아웃은 확인하지 못했습니다. 앱에서 새 비밀번호로 로그인한 뒤 로그인 기기 목록을 확인해 주세요.':'비밀번호가 변경되었습니다. 앱으로 돌아가 다시 로그인해 주세요.';
  }catch{status.textContent='연결하지 못해 변경 결과를 확인하지 못했습니다. 입력을 유지했습니다. 새 비밀번호로 로그인을 확인한 뒤 다시 요청해 주세요.';}finally{busy=false;submit.disabled=false;}
 });
})();`;

export function registerRecoveryPage(app:FastifyInstance){
 app.get('/account/recovery',async(_request,reply)=>reply.header('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'").type('text/html; charset=utf-8').send(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>계정 복구</title><main><h1>비밀번호 재설정</h1><p id="status" role="status">새 비밀번호를 입력해 주세요.</p><form><p><label>새 비밀번호 <input name="password" type="password" minlength="8" maxlength="200" autocomplete="new-password" required></label></p><p><label>비밀번호 확인 <input name="confirm" type="password" minlength="8" maxlength="200" autocomplete="new-password" required></label></p><button>비밀번호 변경</button></form><p>변경 후 Business Assistant 앱에서 다시 로그인하세요.</p></main><script src="/account/recovery.js"></script></html>`));
 app.get('/account/recovery.js',async(_request,reply)=>reply.type('application/javascript; charset=utf-8').send(recoveryScript));
}
