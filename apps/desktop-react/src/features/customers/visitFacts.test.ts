import { expect,it,vi } from 'vitest';
import { loadVisitFacts,operationalCustomers,type VisitFact } from './visitFacts';
import { emptyCustomer } from './types';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const fact:VisitFact={organization_id:org,customer_id:id,last_actual_visit_date:'2026-10-18',next_appointment_at:'2026-10-19T16:00:00Z',recommended_return_date:'2026-11-01',as_of:'2026-10-19T01:00:00Z'};
it('실제 예약의 KST 날짜만 사용하고 수기 프로필·재방문 권장일을 섞지 않는다',()=>{
 const original={...emptyCustomer(),id,organization_id:org,name:'고객',last_visit_date:'2000-01-01',next_visit_date:'2099-01-01'};
 const result=operationalCustomers([original],new Map([[id,fact]]));
 expect(result[0]).toMatchObject({last_visit_date:'2026-10-18',next_visit_date:'2026-10-20'});
 expect(original.next_visit_date).toBe('2099-01-01');
 expect(operationalCustomers([original],new Map())).toEqual([]);
});
it('잘못된 요약은 미확인으로 처리할 수 있도록 실패시킨다',async()=>{
 const call=vi.fn(async()=>[{...fact,organization_id:id}]);
 await expect(loadVisitFacts({call} as never,org,[id])).rejects.toThrow();
});
