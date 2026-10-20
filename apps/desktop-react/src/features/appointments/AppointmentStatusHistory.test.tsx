import { act,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import { AppointmentStatusHistory } from './AppointmentStatusHistory';
const org='11111111-1111-4111-8111-111111111111',apt='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const event={id,organization_id:org,appointment_id:apt,appointment_version:2,previous_status:'reserved',next_status:'no_show',reason:'연락 불가',actor_id:id,occurred_at:'2026-10-19T01:00:00Z'};
it('전후 상태·사유·변경자·KST 시각을 표시하고 예약 버전 변경 때 갱신한다',async()=>{
 const call=vi.fn(async()=>[event]),api={call} as never;
 const {rerender}=render(<AppointmentStatusHistory api={api} organizationId={org} appointmentId={apt} version={2}/>);
 expect(await screen.findByText('예약 → 노쇼')).toBeInTheDocument();
 expect(screen.getByText('연락 불가')).toBeInTheDocument();expect(screen.getByText(new RegExp(id))).toBeInTheDocument();
 rerender(<AppointmentStatusHistory api={api} organizationId={org} appointmentId={apt} version={3}/>);
 await waitFor(()=>expect(call).toHaveBeenCalledTimes(2));
});
it('미적용/실패를 빈 이력으로 표시하지 않고 재시도한다',async()=>{
 const call=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
 render(<AppointmentStatusHistory api={{call} as never} organizationId={org} appointmentId={apt} version={1}/>);
 expect(await screen.findByText(/SQL 062/)).toBeInTheDocument();
 expect(screen.queryByText(/저장된 상태 변경 이력이 없습니다/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'이력 다시 확인'}));
 expect(await screen.findByText(/저장된 상태 변경 이력이 없습니다/)).toBeInTheDocument();
});
it('다른 예약으로 전환한 뒤 이전 응답과 조직/예약 불일치 결과를 표시하지 않는다',async()=>{
 let resolve!:(value:unknown)=>void;
 const call=vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValueOnce([event]);
 const api={call} as never;
 const {rerender}=render(<AppointmentStatusHistory api={api} organizationId={org} appointmentId={apt} version={1}/>);
 rerender(<AppointmentStatusHistory api={api} organizationId={org} appointmentId={id} version={1}/>);
 await screen.findByText(/SQL 062/);
 await act(async()=>resolve([event]));expect(screen.queryByText('연락 불가')).toBeNull();
});
