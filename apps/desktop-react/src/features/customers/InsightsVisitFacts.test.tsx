import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { InsightsPanel } from './InsightsPanel';
import { emptyCustomer } from './types';
import type { VisitFact } from './visitFacts';

const customer={...emptyCustomer(),id:'22222222-2222-4222-8222-222222222222',organization_id:'11111111-1111-4111-8111-111111111111',name:'원장 고객',next_visit_date:'2099-01-01',last_visit_date:'2000-01-01'};
const fact:VisitFact={organization_id:customer.organization_id,customer_id:customer.id,next_appointment_at:'2026-10-20T01:00:00Z',last_actual_visit_date:'2026-10-18',recommended_return_date:'2026-11-01',as_of:'2026-10-19T01:00:00Z'};

it('실제 예약으로 인사이트를 계산해도 선택한 프로필은 수기 값을 보존한다',()=>{
 const onSelect=vi.fn();
 render(<InsightsPanel customers={[customer]} now={new Date('2026-10-19T01:00:00Z')} onSelect={onSelect} visitFacts={{status:'ready',facts:new Map([[customer.id,fact]]),retry:vi.fn()}}/>);
 fireEvent.click(within(screen.getByRole('region',{name:'다음 예약 임박'})).getByRole('button',{name:/원장 고객/}));
 expect(onSelect).toHaveBeenCalledWith(customer);
 expect(onSelect.mock.calls[0][0].next_visit_date).toBe('2099-01-01');
 expect(within(screen.getByRole('region',{name:'장기 미방문'})).queryByRole('button',{name:/원장 고객/})).toBeNull();
});

it('요약 실패는 예약 없음·장기 미방문으로 오인하지 않고 재시도를 제공한다',()=>{
 const retry=vi.fn();
 render(<InsightsPanel customers={[customer]} onSelect={vi.fn()} visitFacts={{status:'error',facts:new Map(),retry}}/>);
 expect(screen.getByRole('region',{name:'다음 예약 임박'})).toHaveTextContent('예약 원장을 확인한 뒤');
 expect(screen.getByRole('region',{name:'장기 미방문'})).toHaveTextContent('방문 원장을 확인한 뒤');
 expect(screen.queryByRole('button',{name:'명단 내보내기'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'방문 정보 다시 확인'}));expect(retry).toHaveBeenCalledOnce();
});
