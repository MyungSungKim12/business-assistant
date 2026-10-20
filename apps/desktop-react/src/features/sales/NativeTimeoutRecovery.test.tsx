import { act,renderHook,waitFor } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import { z } from 'zod';
import { ApiClient } from '../../api/client';
import { createTauriPlatform } from '../../platform/tauri';
import { useRecoverableOperation } from './recovery';
vi.mock('@tauri-apps/plugin-notification',()=>({isPermissionGranted:vi.fn(),requestPermission:vi.fn(),sendNotification:vi.fn()}));

it('Native timeout 후 미확인 수납을 보존하고 명시적 재시도에서 같은 ID를 전송한다',async()=>{
 const key='test.native-timeout.payment';window.localStorage.removeItem(key);
 const bodies:string[]=[];let failed=true;
 const invoke=vi.fn(async(command:string,args?:Record<string,unknown>)=>{
  if(command==='get_config')return {apiBase:'http://127.0.0.1:8000/api/v1',storageHost:''};
  if(command==='http_request'){
   const request=args!.request as {path:string;body:string};
   if(request.path==='/auth/login')return {status:200,headers:{},body:JSON.stringify({access_token:'access',refresh_token:'refresh',user:{user_id:'11111111-1111-4111-8111-111111111111',email:'test@example.invalid',display_name:null}})};
   bodies.push(request.body);
   if(failed)throw {code:'NATIVE_TIMEOUT',message:'응답 시간 초과',retryable:true};
   return {status:200,headers:{},body:JSON.stringify({ok:true})};
  }
 });
 const api=new ApiClient(await createTauriPlatform(invoke));
 await api.login('test@example.invalid','test');
 const execute=(payload:{operation_id:string})=>api.call('POST','/payments',z.object({ok:z.boolean()}),payload);
 const {result}=renderHook(()=>useRecoverableOperation({key,validate:(value:unknown)=>z.object({operation_id:z.string()}).safeParse(value).data??null,execute,onSuccess:vi.fn(),rejected:'거절',unconfirmed:'미확인'}));
 await act(async()=>{await result.current.submit({operation_id:'same-operation'});});
 expect(result.current.message).toBe('미확인');expect(result.current.pending).toEqual({operation_id:'same-operation'});
 expect(window.localStorage.getItem(key)).toContain('same-operation');expect(bodies).toHaveLength(1);
 failed=false;act(()=>result.current.retry());
 await waitFor(()=>expect(result.current.pending).toBeNull());
 expect(bodies).toEqual([JSON.stringify({operation_id:'same-operation'}),JSON.stringify({operation_id:'same-operation'})]);
 expect(window.localStorage.getItem(key)).toBeNull();
});
