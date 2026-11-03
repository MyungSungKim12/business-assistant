import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {confirm} from '@business-assistant/react-ui';
import {DraftBoundary} from '../../app/DraftBoundary';
import {fakeApi,apiFailure} from '../appointment-resources/testApi';
import {BookingPolicyDialog} from './BookingPolicyDialog';
vi.mock('@business-assistant/react-ui',async importOriginal=>({...await importOriginal<typeof import('@business-assistant/react-ui')>(),confirm:vi.fn(async()=>false)}));
const ORG='a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const policy={organization_id:ORG,version:0,enabled:false,timezone_name:'Asia/Seoul',minimum_notice_minutes:0,same_day_cutoff_time:null,hours:[],blocks:[]};
it('keeps failed inputs and operation ID for retry, saves weekly/block rules and clears draft only after success',async()=>{
 let fail=true;const {api,calls}=fakeApi(call=>{if(call.method==='GET')return policy;if(fail)throw apiFailure(503);return {...(call.body as {policy:object}).policy,organization_id:ORG,version:1};});
 const dirty=vi.fn(),busy=vi.fn(),close=vi.fn();
 render(<DraftBoundary onDirtyChange={dirty} onBusyChange={busy}><BookingPolicyDialog api={api} organizationId={ORG} readOnly={false} onClose={close}/></DraftBoundary>);
 await screen.findByLabelText('예약 정책 사용');fireEvent.click(screen.getByLabelText('예약 정책 사용'));
 fireEvent.click(screen.getByRole('button',{name:'영업 구간 추가'}));
 fireEvent.change(screen.getByLabelText('차단 시작 (KST)'),{target:{value:'2030-01-07T10:00'}});fireEvent.change(screen.getByLabelText('차단 종료 (KST)'),{target:{value:'2030-01-07T11:00'}});
 fireEvent.change(screen.getByLabelText('차단 사유'),{target:{value:'교육'}});fireEvent.click(screen.getByRole('button',{name:'차단 추가'}));
 fireEvent.click(screen.getByRole('button',{name:'저장'}));await screen.findByRole('alert');
 expect(screen.getByLabelText('예약 정책 사용')).toBeChecked();expect(dirty).toHaveBeenLastCalledWith(true);expect(busy).toHaveBeenCalledWith(true);
 fireEvent.click(screen.getByRole('button',{name:'취소'}));await waitFor(()=>expect(confirm).toHaveBeenCalled());expect(close).not.toHaveBeenCalled();
 fail=false;fireEvent.click(screen.getByRole('button',{name:'저장'}));await waitFor(()=>expect(dirty).toHaveBeenLastCalledWith(false));
 const writes=calls.filter(c=>c.method==='PUT');expect(writes).toHaveLength(2);expect(writes[0].body).toEqual(writes[1].body);
 expect(writes[0].body).toMatchObject({expected_version:0,policy:{enabled:true,hours:[{weekday:1,start_time:'09:00',end_time:'18:00'}],blocks:[{start_at:'2030-01-07T10:00:00+09:00',end_at:'2030-01-07T11:00:00+09:00',reason:'교육'}]}});
});
it('members read without save controls and failed reads can retry',async()=>{
 let fail=true;const {api,calls}=fakeApi(()=>{if(fail)throw apiFailure(503);return policy;});
 render(<BookingPolicyDialog api={api} organizationId={ORG} readOnly onClose={()=>undefined}/>);
 await screen.findByText('예약 정책을 불러오지 못했습니다.');fail=false;fireEvent.click(screen.getByRole('button',{name:/다시/}));
 expect(await screen.findByLabelText('예약 정책 사용')).toBeDisabled();expect(screen.queryByRole('button',{name:'저장'})).not.toBeInTheDocument();
 expect(calls.every(c=>c.method==='GET')).toBe(true);
});
it('protects pending input fields before they are added to lists and prevents closing during save',async()=>{
 let resolve!:(value:unknown)=>void;const {api}=fakeApi(call=>call.method==='GET'?policy:new Promise(r=>{resolve=r;}));const close=vi.fn(),dirty=vi.fn();
 render(<DraftBoundary onDirtyChange={dirty}><BookingPolicyDialog api={api} organizationId={ORG} readOnly={false} onClose={close}/></DraftBoundary>);
 await screen.findByLabelText('예약 정책 사용');fireEvent.change(screen.getByLabelText('차단 사유'),{target:{value:'작성 중'}});
 expect(dirty).toHaveBeenLastCalledWith(true);
 fireEvent.click(screen.getByRole('button',{name:'저장'}));
 expect(screen.getByRole('button',{name:'취소'})).toBeDisabled();expect(close).not.toHaveBeenCalled();
 resolve({...policy,version:1});await waitFor(()=>expect(screen.getByRole('button',{name:'취소'})).not.toBeDisabled());
 // Unsubmitted list editor text must remain protected after saving other policy fields.
 expect(screen.getByLabelText('차단 사유')).toHaveValue('작성 중');expect(dirty).toHaveBeenLastCalledWith(true);
});
it('rejects invalid ranges without discarding input, and handles accepted cancellation',async()=>{
 const {api,calls}=fakeApi(()=>policy),close=vi.fn();
 render(<BookingPolicyDialog api={api} organizationId={ORG} readOnly={false} onClose={close}/>);
 await screen.findByLabelText('예약 정책 사용');
 fireEvent.click(screen.getByRole('button',{name:'영업 구간 추가'}));fireEvent.change(screen.getByLabelText('영업 종료 1'),{target:{value:'08:00'}});
 fireEvent.click(screen.getByRole('button',{name:'저장'}));await screen.findByRole('alert');expect(calls.filter(c=>c.method==='PUT')).toHaveLength(0);
 expect(screen.getByLabelText('영업 종료 1')).toHaveValue('08:00');vi.mocked(confirm).mockResolvedValueOnce(true);
 fireEvent.click(screen.getByRole('button',{name:'취소'}));await waitFor(()=>expect(close).toHaveBeenCalledOnce());
});
it('ignores stale organization responses and permission changes remove save controls',async()=>{
 const other='22222222-2222-4222-8222-222222222222';let resolve!:(value:unknown)=>void;
 const {api}=fakeApi(call=>call.path.includes(ORG)?new Promise(r=>{resolve=r;}):{...policy,organization_id:other});
 const {rerender}=render(<BookingPolicyDialog api={api} organizationId={ORG} readOnly={false} onClose={()=>undefined}/>);
 rerender(<BookingPolicyDialog api={api} organizationId={other} readOnly onClose={()=>undefined}/>);
 await screen.findByLabelText('예약 정책 사용');resolve({...policy,enabled:true});
 await waitFor(()=>expect(screen.getByLabelText('예약 정책 사용')).not.toBeChecked());expect(screen.getByLabelText('예약 정책 사용')).toBeDisabled();expect(screen.queryByRole('button',{name:'저장'})).not.toBeInTheDocument();
});
