import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import { StaffProfileDialog } from './StaffProfileDialog';
vi.mock('@business-assistant/react-ui',async original=>({...await original<object>(),confirm:vi.fn(async()=>true)}));
const staff={id:'22222222-2222-4222-8222-222222222222',organization_id:'11111111-1111-4111-8111-111111111111',name:'직원',is_active:true,schedule_version:1,profile_version:1};
it('저장 실패 시 입력과 같은 요청 ID를 보존하고 재시도한다',async()=>{
 const call=vi.fn().mockRejectedValueOnce({status:503}).mockResolvedValueOnce({...staff,name:'수정',profile_version:2}),onSaved=vi.fn();
 render(<StaffProfileDialog api={{call} as never} organizationId={staff.organization_id} staff={staff} onSaved={onSaved} onClose={vi.fn()}/>);
 fireEvent.change(screen.getByLabelText('직원 이름'),{target:{value:'수정'}});
 fireEvent.click(screen.getByRole('button',{name:'저장'}));await screen.findByRole('alert');
 expect(screen.getByLabelText('직원 이름')).toHaveValue('수정');
 fireEvent.click(screen.getByRole('button',{name:'저장'}));await waitFor(()=>expect(onSaved).toHaveBeenCalled());
 expect(call.mock.calls[0][3].operation_id).toBe(call.mock.calls[1][3].operation_id);
});
it('중지 충돌은 재배정 안내를 표시하고 입력을 보존한다',async()=>{
 const call=vi.fn().mockRejectedValue({status:409});
 render(<StaffProfileDialog api={{call} as never} organizationId={staff.organization_id} staff={staff} onSaved={vi.fn()} onClose={vi.fn()}/>);
 fireEvent.click(screen.getByLabelText('예약 담당 사용'));
 fireEvent.click(screen.getByRole('button',{name:'저장'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('재배정');
 expect(screen.getByLabelText('예약 담당 사용')).not.toBeChecked();
});
it('SQL 미적용으로 버전이 없으면 저장하지 않는다',()=>{
 render(<StaffProfileDialog api={{} as never} organizationId={staff.organization_id} staff={{...staff,profile_version:undefined}} onSaved={vi.fn()} onClose={vi.fn()}/>);
 expect(screen.getByRole('button',{name:'저장'})).toBeDisabled();
 expect(screen.getByText(/SQL 063/)).toBeInTheDocument();
});
