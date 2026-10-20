import { fireEvent,render,screen } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import { StaffPage } from './StaffPage';
const staff={id:'22222222-2222-4222-8222-222222222222',organization_id:'11111111-1111-4111-8111-111111111111',name:'테스트 직원',is_active:true,schedule_version:1,profile_version:1};
it('직원 선택 후 정보 수정 팝업을 연다',async()=>{
 render(<StaffPage api={{call:vi.fn(async()=>[staff])} as never} organizationId={staff.organization_id} readOnly={false}/>);
 fireEvent.click(await screen.findByText('테스트 직원'));
 fireEvent.click(screen.getByRole('button',{name:'직원 정보 수정'}));
 expect(screen.getByLabelText('직원 이름')).toHaveValue('테스트 직원');
});
it('구성원 조회 전용에는 직원 정보 수정 동작을 제공하지 않는다',async()=>{
 render(<StaffPage api={{call:vi.fn(async()=>[staff])} as never} organizationId={staff.organization_id} readOnly/>);
 await screen.findByText('테스트 직원');
 expect(screen.queryByRole('button',{name:'직원 정보 수정'})).toBeNull();
 expect(screen.queryByRole('button',{name:'직원 추가'})).toBeNull();
});
