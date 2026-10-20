import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import { CustomerForm } from './CustomerForm';
import { emptyCustomer } from './types';
it('고객 주요 프로필을 입력·저장하고 실패 시 보존한다',async()=>{
 const onSave=vi.fn(async()=>false);
 render(<CustomerForm value={{...emptyCustomer(),name:'고객'}} readOnly={false} onSave={onSave}/>);
 fireEvent.change(screen.getByLabelText('생년월일'),{target:{value:'1990-03-12'}});
 fireEvent.change(screen.getByLabelText('피부 타입'),{target:{value:'민감성'}});
 fireEvent.change(screen.getByLabelText('알레르기·주의사항'),{target:{value:'라텍스'}});
 fireEvent.change(screen.getByLabelText('관심 항목'),{target:{value:'보습, 진정, 보습'}});
 fireEvent.click(screen.getByRole('button',{name:'저장'}));
 await waitFor(()=>expect(onSave).toHaveBeenCalledWith(expect.objectContaining({birth_date:'1990-03-12',skin_type:'민감성',allergies:'라텍스',concerns:['보습','진정']})));
 expect(screen.getByLabelText('알레르기·주의사항')).toHaveValue('라텍스');
});
it('조회 전용은 주요 프로필을 수정하지 못한다',()=>{
 render(<CustomerForm value={emptyCustomer()} readOnly onSave={vi.fn()}/>);
 for(const name of ['생년월일','피부 타입','알레르기·주의사항','관심 항목'])expect(screen.getByLabelText(name)).toBeDisabled();
});
