import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { WaitlistDialog } from './WaitlistDialog';

const org='22222222-2222-4222-8222-222222222222',customerId='11111111-1111-4111-8111-111111111111',staffId='33333333-3333-4333-8333-333333333333',serviceId='44444444-4444-4444-8444-444444444444',waitId='55555555-5555-4555-8555-555555555555';
const waitRow={id:waitId,organization_id:org,customer_id:customerId,service_id:serviceId,staff_id:staffId,preferred_date:'2026-11-20',note:'오전 가능',status:'waiting',version:1,created_at:'2026-10-20T00:00:00Z'};

describe('WaitlistDialog internal ranked offers',()=>{
 it('creates a private proposal for the chosen waitlist slot',async()=>{
  let hasProposal=false;const proposal={id:'66666666-6666-4666-8666-666666666666',organization_id:org,offer_group_id:'77777777-7777-4777-8777-777777777777',waitlist_id:waitId,rank:1,staff_id:staffId,start_at:'2026-11-20T01:00:00Z',resource_ids:[],status:'offered',version:1,acted_by:null,acted_at:null,appointment_id:null,created_at:'2026-10-20T00:00:00Z',expires_at:'2026-10-21T00:00:00Z'};
  const call=vi.fn(async(method:string,path:string)=>{
   if(method==='GET'&&path.endsWith('/appointment-waitlist'))return[waitRow];
   if(method==='GET'&&path.includes('/offers'))return hasProposal?[proposal]:[];
   if(method==='GET')return[];
   hasProposal=true;return [proposal];
  });
  render(<WaitlistDialog api={{call} as unknown as ApiClient} organizationId={org} customers={[{id:customerId,name:'고객',phone:null,status:'active'} as never]} staff={[{id:staffId,name:'담당자',is_active:true} as never]} services={[{id:serviceId,name:'관리'} as never]} resources={[]} readOnly={false} onBooked={()=>undefined} onClose={()=>undefined}/>);
  fireEvent.click(await screen.findByRole('button',{name:'예약 만들기'}));
  await waitFor(()=>expect(screen.getByTestId('resource-requirement')).toHaveTextContent('필수 기준: 필수 자원 없음'));
  fireEvent.click(screen.getByRole('button',{name:'제안 후보에 추가'}));
  fireEvent.click(screen.getByRole('button',{name:'제안 후보 저장 (1개)'}));
  await waitFor(()=>expect(call).toHaveBeenCalledWith('POST',expect.stringContaining(`/appointment-waitlist/${waitId}/offers`),expect.anything(),expect.objectContaining({offers:[expect.objectContaining({staff_id:staffId})]})));
  expect(await screen.findByText(/제안 중/)).toBeInTheDocument();
 });
});
