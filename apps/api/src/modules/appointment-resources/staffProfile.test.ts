import { expect,it } from 'vitest';
import { registerAppointmentResourceModule } from './index.js';
import { auth,buildApp,fakeFetch,fakeOrganizations,ORG,OTHER_ORG,OP,testConfig } from '../catalog/testkit.js';
const staff='22222222-2222-4222-8222-222222222222';
const saved={id:staff,organization_id:ORG,name:'수정',is_active:false,schedule_version:1,profile_version:2};
const input={name:' 수정 ',is_active:false,expected_version:1,operation_id:OP};
const path=`/api/v1/organizations/${ORG}/appointment-staff/${staff}`;
it('직원 프로필 수정은 관리자로 제한하고 ID·조직·버전·멱등 키를 검증한다',async()=>{
 for(const role of ['owner','member','outsider'] as const){
  const {fetcher,calls}=fakeFetch(()=>({body:saved}));
  const app=buildApp(a=>registerAppointmentResourceModule(a,fakeOrganizations(role,['task.basic']),testConfig,fetcher));
  try{const r=await app.inject({method:'PUT',url:path,headers:auth,payload:input});expect(r.statusCode).toBe(role==='owner'?200:403);if(role==='owner'){expect(r.json().profile_version).toBe(2);expect(calls[0].body).toEqual({p_organization_id:ORG,p_staff_id:staff,p_name:'수정',p_is_active:false,p_expected_version:1,p_operation_id:OP});}else expect(calls).toHaveLength(0);}finally{await app.close();}
 }
});
it('잘못된 버전·이름·조직 혼입 결과를 거절한다',async()=>{
 const {fetcher}=fakeFetch(()=>({body:{...saved,organization_id:OTHER_ORG}}));
 const app=buildApp(a=>registerAppointmentResourceModule(a,fakeOrganizations('owner',['task.basic']),testConfig,fetcher));
 try{for(const payload of [{...input,name:''},{...input,expected_version:0},{...input,role:'admin'}])expect((await app.inject({method:'PUT',url:path,headers:auth,payload})).statusCode).toBe(422);expect((await app.inject({method:'PUT',url:path,headers:auth,payload:input})).statusCode).toBe(503);}finally{await app.close();}
});
