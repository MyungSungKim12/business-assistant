import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {DraftBoundary} from '../../app/DraftBoundary';
import {PhoneInboxPage} from './PhoneInboxPage';
import type {ApiClient} from '../../api/client';
import {confirm} from '@business-assistant/react-ui';
vi.mock('@business-assistant/react-ui',async original=>({...await original<typeof import('@business-assistant/react-ui')>(),confirm:vi.fn(async()=>false)}));
const org='a9cc39fd-8e8c-4df8-a623-1f23a3a936bd',id='b9cc39fd-8e8c-4df8-a623-1f23a3a936bd',customer='c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const record={id,organization_id:org,recipient_id:org,phone_e164:'+821012345678',occurred_at:'2026-11-02T01:00:00Z',received_at:'2026-11-02T01:00:00Z',expires_at:'2026-11-02T01:02:00Z',retained:true,retained_until:'2026-12-02T01:00:00Z',customer_ids:[customer],status:'unconfirmed',assignee_id:null,version:1,callback_task_id:null};
function fixture(handler?:(input:Record<string,unknown>)=>unknown){const writes:Record<string,unknown>[]=[];return {writes,api:{getPhoneRetentionConsent:async()=>({enabled:false,version:0,retention_days:30}),listPhoneInbox:async()=>({items:[record],next_cursor:null,cursor:'a'}),getCustomer:async()=>({id:customer,organization_id:org,name:'김고객'}),listTaskPeople:async()=>[{user_id:org,name:'나'}],respondPhoneInbox:async(_o:string,_id:string,input:Record<string,unknown>)=>{writes.push(input);return handler?handler(input):{...record,...input,version:2};}} as unknown as ApiClient};}
it('opens a confirmed record without declaring call completion and masks the number',async()=>{
 const {api,writes}=fixture();render(<PhoneInboxPage api={api} organizationId={org}/>);
 fireEvent.click(await screen.findByRole('button',{name:'응대 기록 열기'}));
 await waitFor(()=>expect(writes).toHaveLength(1));expect(writes[0]).toMatchObject({status:'seen',expected_version:1});
 expect(screen.queryByText('+821012345678')).not.toBeInTheDocument();
 expect((await screen.findAllByText(/30일/)).length).toBeGreaterThan(0);
});
it('protects failed memo, keeps the same operation for retry and blocks selection/cancel while dirty',async()=>{
 let fail=true;const {api,writes}=fixture(input=>{if(input.memo&&fail)throw Object.assign(new Error('offline'),{status:503});return {...record,...input,version:input.memo?3:2};});const dirty=vi.fn();
 render(<DraftBoundary onDirtyChange={dirty}><PhoneInboxPage api={api} organizationId={org}/></DraftBoundary>);
 fireEvent.click(await screen.findByRole('button',{name:'응대 기록 열기'}));await screen.findByLabelText('응대 메모');
 fireEvent.change(screen.getByLabelText('응대 메모'),{target:{value:'예약 문의'}});fireEvent.click(screen.getByRole('button',{name:'응대 저장'}));
 await screen.findByRole('alert');expect(screen.getByLabelText('응대 메모')).toHaveValue('예약 문의');expect(dirty).toHaveBeenLastCalledWith(true);
 fireEvent.click(screen.getAllByRole('button',{name:'닫기'})[0]!);await waitFor(()=>expect(confirm).toHaveBeenCalled());expect(screen.getByLabelText('응대 메모')).toBeInTheDocument();
 fail=false;fireEvent.click(screen.getByRole('button',{name:'응대 저장'}));await waitFor(()=>expect(writes.filter(w=>w.memo)).toHaveLength(2));
 expect(writes.filter(w=>w.memo)[0]).toEqual(writes.filter(w=>w.memo)[1]);await waitFor(()=>expect(dirty).toHaveBeenLastCalledWith(false));
});
it('preserves draft after version conflict until an explicit refresh',async()=>{
 const {api}=fixture(input=>{if(input.memo)throw Object.assign(new Error('changed'),{status:409});return {...record,version:2,status:'seen'};});
 render(<PhoneInboxPage api={api} organizationId={org}/>);fireEvent.click(await screen.findByRole('button',{name:'응대 기록 열기'}));await screen.findByLabelText('응대 메모');
 fireEvent.change(screen.getByLabelText('응대 메모'),{target:{value:'보존'}});fireEvent.click(screen.getByRole('button',{name:'응대 저장'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('다른 사람이');expect(screen.getByLabelText('응대 메모')).toHaveValue('보존');expect(screen.getByRole('button',{name:'응대 저장'})).toBeDisabled();
});
it('shows read permission failure, retries and applies bounded date/status filters with pagination',async()=>{
 const {api}=fixture();let fail=true;const list=vi.fn(async()=>{if(fail)throw Object.assign(new Error('denied'),{status:403});return {items:[record],cursor:'first',next_cursor:'next'};});api.listPhoneInbox=list as never;
 render(<PhoneInboxPage api={api} organizationId={org}/>);expect(await screen.findByRole('alert')).toHaveTextContent('권한');
 fail=false;fireEvent.click(screen.getByRole('button',{name:'다시 불러오기'}));await screen.findByRole('button',{name:'응대 기록 열기'});
 fireEvent.change(screen.getByLabelText('시작일'),{target:{value:'2026-11-01'}});fireEvent.change(screen.getByLabelText('종료일'),{target:{value:'2026-11-02'}});fireEvent.change(screen.getByLabelText('상태'),{target:{value:'completed'}});fireEvent.click(screen.getByRole('button',{name:'조회'}));
 await waitFor(()=>expect(list).toHaveBeenLastCalledWith(org,expect.objectContaining({limit:30,status:'completed',from:'2026-11-01T00:00:00+09:00',to:'2026-11-02T15:00:00.000Z'})));
 fireEvent.click(screen.getByRole('button',{name:'다음 페이지'}));await waitFor(()=>expect(list).toHaveBeenLastCalledWith(org,expect.objectContaining({after:'next',limit:30})));
});
it('blocks closing and fields while an uncertain save is in progress',async()=>{
 let resolve!:(value:unknown)=>void;const {api}=fixture(input=>input.memo?new Promise(r=>{resolve=r;}):{...record,status:'seen',version:2});
 render(<PhoneInboxPage api={api} organizationId={org}/>);fireEvent.click(await screen.findByRole('button',{name:'응대 기록 열기'}));await screen.findByLabelText('응대 메모');
 fireEvent.change(screen.getByLabelText('응대 메모'),{target:{value:'진행 중'}});fireEvent.click(screen.getByRole('button',{name:'응대 저장'}));
 expect(screen.getByLabelText('응대 메모')).toBeDisabled();expect(screen.getByRole('button',{name:'응대 저장'})).toBeDisabled();
 fireEvent.click(screen.getAllByRole('button',{name:'닫기'})[0]!);expect(screen.getByLabelText('응대 메모')).toHaveValue('진행 중');
 resolve({...record,status:'seen',version:3});await waitFor(()=>expect(screen.getByLabelText('응대 메모')).not.toBeDisabled());expect(screen.getByLabelText('응대 메모')).toHaveValue('');
});
