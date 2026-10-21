import { fireEvent,render,screen,within } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import { StaffPage } from './StaffPage';
const staff={id:'22222222-2222-4222-8222-222222222222',organization_id:'11111111-1111-4111-8111-111111111111',name:'테스트 직원',is_active:true,schedule_version:1,profile_version:1};
it('직원 선택 후 정보 수정 팝업을 연다',async()=>{
 render(<StaffPage api={{call:vi.fn(async(_method:string,path:string)=>path.includes('/staff-commission-settlements')?[]:[staff])} as never} organizationId={staff.organization_id} readOnly={false}/>);
 fireEvent.click(await screen.findByText('테스트 직원'));
 fireEvent.click(screen.getByRole('button',{name:'직원 정보 수정'}));
 expect(screen.getByLabelText('직원 이름')).toHaveValue('테스트 직원');
});
it('구성원 조회 전용에는 직원 정보 수정 동작을 제공하지 않는다',async()=>{
 render(<StaffPage api={{call:vi.fn(async(_method:string,path:string)=>path.includes('/staff-commission-settlements')?[]:[staff])} as never} organizationId={staff.organization_id} readOnly/>);
 await screen.findByText('테스트 직원');
 expect(screen.queryByRole('button',{name:'직원 정보 수정'})).toBeNull();
 expect(screen.queryByRole('button',{name:'직원 추가'})).toBeNull();
});

it('확정 정산 기간을 골라 직원별 수납 배분과 환불 차감 후 확정 수당을 집계한다',async()=>{
 const history=[{settlement:{id:'88888888-8888-4888-8888-888888888888',organization_id:staff.organization_id,from_date:'2026-09-01',to_date:'2026-09-30',status:'confirmed',total_commission:'8000'},lines:[
  {id:'99999999-9999-4999-8999-999999999991',source_event_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',event_kind:'receipt',sale_line_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',staff_id:staff.id,staff_name_snapshot:'테스트 직원',commission_scope:'service',net_paid_amount:'100000',commission_amount:'10000'},
  {id:'99999999-9999-4999-8999-999999999992',source_event_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',event_kind:'refund',sale_line_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',staff_id:staff.id,staff_name_snapshot:'테스트 직원',commission_scope:'service',net_paid_amount:'-20000',commission_amount:'-2000'},
 ]}];
 const api={call:vi.fn(async(_method:string,path:string)=>path.includes('/staff-commission-settlements')?history:[staff])};
 render(<StaffPage api={api as never} organizationId={staff.organization_id} readOnly={false}/>);
 const grid=within(await screen.findByRole('grid',{name:'직원별 확정 성과'}));
 expect(screen.getByLabelText('성과 조회 정산 기간')).toHaveValue(history[0].settlement.id);
 expect(grid.getByText('테스트 직원')).toBeInTheDocument();
 expect(grid.getByText('80,000원')).toBeInTheDocument();
 expect(grid.getByText('8,000원')).toBeInTheDocument();
 expect(grid.getByText('2')).toBeInTheDocument();
});

it('확정 수당 집계 조회 실패를 빈 성공으로 숨기지 않는다',async()=>{
 const api={call:vi.fn(async(_method:string,path:string)=>{if(path.includes('/staff-commission-settlements'))throw new Error('network');return[staff];})};
 render(<StaffPage api={api as never} organizationId={staff.organization_id} readOnly={false}/>);
 expect(await screen.findByRole('alert')).toHaveTextContent('확정 수당 집계를 불러오지 못했습니다');
 expect(screen.queryByText('확정된 정산이 없습니다. 관리자에게 수당 규칙과 정산 완료 여부를 확인하세요.')).toBeNull();
});
