import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { treatmentApi } from './api';
import { treatmentSchema } from './schemas';
import { TreatmentVisitLink } from './TreatmentVisitLink';
const org='22222222-2222-4222-8222-222222222222',customerId='11111111-1111-4111-8111-111111111111',id='44444444-4444-4444-8444-444444444444';
const record=treatmentSchema.parse({id,organization_id:org,customer_id:customerId,treatment_date:'2026-10-20',treatment_name:'관리',category:'',practitioner:'',notes:'',amount:null,next_visit_date:null,status:'draft',version:1,started_at:null,ended_at:null});
const appointment={id:'appt',organization_id:org,customer_id:customerId,service_name_snapshot:'수분 관리',start_at:'2026-10-20T01:00:00Z',status:'checked_in' as const};
const visit={id:'visit',organization_id:org,customer_id:customerId,appointment_id:'appt',opened_at:'2026-10-20T01:00:00Z',status:'open' as const};
const options={appointments:[appointment],visits:[visit,{...visit,id:'walkin',appointment_id:null}]};
const api={} as ApiClient,onSaved=vi.fn(),onClose=vi.fn();
const props={api,organizationId:org,customerId,record,readOnly:false,onSaved,onClose,preferredAppointmentId:'appt'};
beforeEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();vi.spyOn(treatmentApi,'contextOptions').mockResolvedValue(options);vi.spyOn(treatmentApi,'linkVisit').mockResolvedValue({...record,appointment_id:'appt',visit_id:'visit',version:2});});
const open=async()=>{render(<><TreatmentVisitLink {...props}/><ConfirmDialog/></>);await screen.findByRole('option',{name:/수분 관리/});};
const save=()=>fireEvent.click(screen.getByRole('button',{name:'연결 저장'}));
const reason=()=>fireEvent.change(screen.getByLabelText('연결·해제 사유'),{target:{value:'접수 기록 확인'}});
describe('시술 예약·방문 명시 연결',()=>{
 it('예약 진입값은 선택만 하고 명시 저장 전까지 원장을 바꾸지 않는다',async()=>{
  await open();expect(screen.getByLabelText('연결 예약')).toHaveValue('appt');expect(treatmentApi.linkVisit).not.toHaveBeenCalled();
  reason();save();await waitFor(()=>expect(onSaved).toHaveBeenCalled());
  expect(treatmentApi.linkVisit).toHaveBeenCalledWith(api,org,customerId,id,expect.objectContaining({appointment_id:'appt',visit_id:null,expected_version:1,reason:'접수 기록 확인'}));
 });
 it('예약 방문 선택과 워크인 전환은 예약 조합을 일치시킨다',async()=>{
  await open();fireEvent.change(screen.getByLabelText('연결 방문'),{target:{value:'visit'}});reason();save();
  await waitFor(()=>expect(treatmentApi.linkVisit).toHaveBeenCalledWith(api,org,customerId,id,expect.objectContaining({appointment_id:'appt',visit_id:'visit'})));
 });
 it('워크인 방문은 예약 없이 저장하고 예약 변경 시 이전 방문을 지운다',async()=>{
  await open();fireEvent.change(screen.getByLabelText('연결 방문'),{target:{value:'visit'}});
  fireEvent.change(screen.getByLabelText('연결 예약'),{target:{value:''}});expect(screen.getByLabelText('연결 방문')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('연결 방문'),{target:{value:'walkin'}});reason();save();
  await waitFor(()=>expect(treatmentApi.linkVisit).toHaveBeenCalledWith(api,org,customerId,id,expect.objectContaining({appointment_id:null,visit_id:'walkin'})));
 });
 it('사유 없는 저장을 막고 실패 후 같은 요청의 키를 보존한다',async()=>{
  vi.mocked(treatmentApi.linkVisit).mockRejectedValueOnce(new ApiError(0,'NETWORK','offline',true));
  await open();save();expect(await screen.findByText('연결·해제 사유를 입력하세요.')).toBeInTheDocument();expect(treatmentApi.linkVisit).not.toHaveBeenCalled();
  reason();save();await screen.findByRole('button',{name:'같은 연결 요청 재시도'});
  const first=vi.mocked(treatmentApi.linkVisit).mock.calls[0][4];fireEvent.click(screen.getByRole('button',{name:'같은 연결 요청 재시도'}));
  await waitFor(()=>expect(onSaved).toHaveBeenCalled());expect(vi.mocked(treatmentApi.linkVisit).mock.calls[1][4]).toEqual(first);
 });
 it('조회 실패를 비어 있는 선택지로 처리하지 않고 재시도한다',async()=>{
  vi.mocked(treatmentApi.contextOptions).mockRejectedValueOnce(new Error('offline'));
  render(<TreatmentVisitLink {...props}/>);expect(await screen.findByText(/예약·방문을 불러오지 못했습니다/)).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'연결 저장'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'선택지 다시 불러오기'}));
  await screen.findByRole('option',{name:/수분 관리/});
 });
 it('다른 고객 선택지와 누락된 예약 진입값을 거부한다',async()=>{
  vi.mocked(treatmentApi.contextOptions).mockResolvedValue({...options,appointments:[{...appointment,customer_id:'wrong'}]});
  render(<TreatmentVisitLink {...props}/>);expect(await screen.findByText(/예약·방문을 불러오지 못했습니다/)).toBeInTheDocument();
  expect(screen.queryByRole('option',{name:/수분 관리/})).not.toBeInTheDocument();
 });
 it('입력한 사유를 취소 확인에서 계속 작성 선택 시 보존한다',async()=>{
  await open();reason();fireEvent.click(screen.getByText('닫기',{selector:'button'}));
  const dialog=await screen.findByRole('dialog',{name:'예약·방문 연결'});expect(dialog).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'취소'}));expect(onClose).not.toHaveBeenCalled();expect(screen.getByLabelText('연결·해제 사유')).toHaveValue('접수 기록 확인');
 });
 it('완료 기록은 조회만 허용한다',async()=>{
  render(<TreatmentVisitLink {...props} readOnly record={{...record,status:'completed',appointment_id:'appt',visit_id:'visit'}}/>);
  await screen.findByRole('option',{name:/수분 관리/});expect(screen.queryByRole('button',{name:'연결 저장'})).not.toBeInTheDocument();
 });
 it('버전 충돌 시 입력을 유지하고 새 키로 무작정 재전송하지 않는다',async()=>{
  vi.mocked(treatmentApi.linkVisit).mockRejectedValue(new ApiError(409,'CONFLICT','conflict',false));
  await open();reason();save();expect(await screen.findByText(/시술 기록이 변경되었습니다/)).toBeInTheDocument();
  expect(screen.getByLabelText('연결·해제 사유')).toHaveValue('접수 기록 확인');expect(screen.getByRole('button',{name:'연결 저장'})).toBeDisabled();
 });
 it('누락된 예약 진입값을 다른 예약으로 임의 대체하지 않는다',async()=>{
  render(<TreatmentVisitLink {...props} preferredAppointmentId="missing"/>);
  expect(await screen.findByText(/진입한 예약을 찾을 수 없거나/)).toBeInTheDocument();expect(screen.getByLabelText('연결 예약')).toHaveValue('');expect(treatmentApi.linkVisit).not.toHaveBeenCalled();
 });
 it('조직·고객 전환 후 늦은 이전 선택지 응답을 무시한다',async()=>{
  let resolve!:(value:typeof options)=>void;
  vi.mocked(treatmentApi.contextOptions).mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValueOnce({appointments:[],visits:[]});
  const {rerender}=render(<TreatmentVisitLink {...props}/>);
  rerender(<TreatmentVisitLink {...props} customerId="next" preferredAppointmentId={undefined} record={{...record,customer_id:'next'}}/>);
  await screen.findByText('연결할 예약·기존 방문을 선택하고 사유와 함께 저장하세요.');resolve(options);
  await waitFor(()=>expect(screen.queryByRole('option',{name:/수분 관리/})).not.toBeInTheDocument());
 });
});
