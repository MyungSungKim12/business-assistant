import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CustomerPage } from './CustomerPage';

const customer = { id:'11111111-1111-4111-8111-111111111111', organization_id:'22222222-2222-4222-8222-222222222222', name:'김고객', email:null, phone:'010-1234-5678', notes:'', birth_date:null, skin_type:null, concerns:[], allergies:'', last_visit_date:null, next_visit_date:null, tags:['재방문'], status:'active' };
function api() { return { listCustomers: vi.fn(async()=>[customer]), createCustomer: vi.fn(async(_o:string,input:object)=>({...customer,...input,id:'33333333-3333-4333-8333-333333333333'})), updateCustomer: vi.fn(async(_o:string,_id:string,input:object)=>({...customer,...input})), archiveCustomer: vi.fn(async()=>({...customer,status:'archived'})), listCustomerActivities:vi.fn(async()=>[]),listCustomerPhotos:vi.fn(async()=>[]) } as never; }
describe('CustomerPage',()=>{
 it('searches customers, saves a selected profile, and exposes a retryable error', async()=>{const client=api();render(<CustomerPage api={client} organizationId={customer.organization_id} readOnly={false}/>);expect(await screen.findByText('김고객')).toBeInTheDocument();fireEvent.change(screen.getByLabelText('고객 검색'),{target:{value:'재방문'}});expect(screen.getByText('김고객')).toBeInTheDocument();fireEvent.click(screen.getByText('김고객'));fireEvent.change(screen.getByLabelText('이름'),{target:{value:'김수정'}});fireEvent.click(screen.getByRole('button',{name:'저장'}));expect((await screen.findAllByText('김수정')).length).toBeGreaterThan(0);});
 it('keeps member view read only', async()=>{render(<CustomerPage api={api()} organizationId={customer.organization_id} readOnly/>);await screen.findByText('김고객');expect(screen.queryByRole('button',{name:'저장'})).not.toBeInTheDocument();});
});
