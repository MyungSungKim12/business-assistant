import { expect,it,vi } from 'vitest';
import { createApp } from '../app.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
it('고객 날짜·프로필 길이를 검증하고 잘못된 입력은 저장하지 않는다',async()=>{
 const update=vi.fn();
 const app=createApp({organizations:{requireAccess:async()=> 'owner'} as never,customers:{update} as never});
 try{for(const payload of [{birth_date:'2026-02-30'},{birth_date:'1990/03/12'},{last_visit_date:'yesterday'},{next_visit_date:'2026-13-01'},{allergies:'x'.repeat(1001)},{concerns:Array(31).fill('보습')}]){
  expect((await app.inject({method:'PATCH',url:`/api/v1/organizations/${org}/customers/${id}`,headers:{authorization:'Bearer t'},payload})).statusCode).toBe(422);
 }expect(update).not.toHaveBeenCalled();}finally{await app.close();}
});
