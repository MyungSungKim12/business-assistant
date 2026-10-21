import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { describe,expect,it,vi } from 'vitest';
import { fakeApi } from '../appointment-resources/testApi';
import { AvailabilitySearch } from './AvailabilitySearch';

const ORG='22222222-2222-4222-8222-222222222222',SERVICE='44444444-4444-4444-8444-444444444444',STAFF='33333333-3333-4333-8333-333333333333';
const recommendation={date:'2026-12-15',start:'10:00',start_at:'2026-12-15T10:00:00+09:00',end_at:'2026-12-15T11:00:00+09:00',staff_ids:[STAFF],available_staff_count:1,duration_minutes:60,buffer_minutes:10,required_resources:[{kind:'room' as const,quantity:1},{kind:'equipment' as const,quantity:2}],reason:'가장 이른 예약 가능 시간입니다. 담당 가능 1명'};

describe('AvailabilitySearch',()=>{
 it('검색 범위와 자원을 한 요청으로 보내고 추천 선택 시 날짜·직원·시각을 반환한다',async()=>{
  const {api,calls}=fakeApi(()=>({service_id:SERVICE,from_date:'2026-12-14',to_date:'2026-12-27',step_minutes:30,recommendations:[recommendation],advisory:'저장 때 다시 확인'}));
  const onPick=vi.fn();
  render(<AvailabilitySearch api={api as never} organizationId={ORG} serviceId={SERVICE} staffId="" resourceIds={[STAFF]} startDate="2026-12-14" staff={[{id:STAFF,name:'김담당'}]} onPick={onPick}/>);
  fireEvent.click(screen.getByRole('button',{name:'빈 시간 추천'}));
  fireEvent.change(screen.getByLabelText('추천 검색 기간'),{target:{value:'14'}});
  fireEvent.click(screen.getByRole('button',{name:'추천 찾기'}));
  const option=await screen.findByRole('button',{name:/2026-12-15 · 10:00/});
  expect(option).toHaveTextContent('필수 자원 조건 통과: 공간 1개 · 장비 2개');
  await waitFor(()=>expect(calls).toHaveLength(1));
  expect(calls[0].path).toContain('appointment-availability-search');expect(calls[0].path).toContain('days=14');expect(calls[0].path).toContain(`resource_ids=${STAFF}`);
  fireEvent.click(option);expect(onPick).toHaveBeenCalledWith('2026-12-15','10:00',STAFF);
 });
});
