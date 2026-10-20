import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { describe, expect, it } from 'vitest';
import { SalesPage } from './SalesPage';
import { ORG, CUSTOMER, VISIT, bundle, cartLine, fakeApi, network, uid, visit } from './testkit';

const appointment=uid(42);
const linked=visit({appointment_id:appointment});
const request={appointmentId:appointment,customerId:CUSTOMER,nonce:1};
function setup(visits:()=>unknown=()=>[linked],cart= bundle({visit:{appointment_id:appointment},lines:[cartLine({description_snapshot:'예약 방문 청구'})]})){
  const kit=fakeApi({'GET /visits':visits,'GET /sale-cart-drafts':()=>[],'GET /visits/:id/sale-cart':()=>cart});
  render(<><SalesPage api={kit.api} organizationId={ORG} readOnly={false} appointmentRequest={request}/><ConfirmDialog/></>);
  return kit;
}
describe('예약 방문 장바구니 연결',()=>{
  it('연결된 기존 방문만 열고 방문·결제를 자동 생성하지 않는다',async()=>{
    const kit=setup();
    expect(await screen.findByText('예약 방문 청구')).toBeInTheDocument();
    expect(kit.calls.some(call=>call.path.includes(`appointment_id=${appointment}`)&&call.path.includes(`customer_id=${CUSTOMER}`))).toBe(true);
    expect(kit.calls.some(call=>call.path===`/visits/${VISIT}/sale-cart`)).toBe(true);
    expect(kit.calls.every(call=>call.method==='GET')).toBe(true);
  });
  it.each([[],[linked,linked],[{...linked,customer_id:uid(99)}],[{...linked,organization_id:uid(99)}],[{...linked,appointment_id:uid(99)}],[{...linked,status:'canceled'}]].map(rows=>({rows})))('없거나 모호한 방문은 자동 생성으로 대체하지 않는다: $rows',async({rows})=>{
    const kit=setup(()=>rows);
    expect(await screen.findByRole('alert')).toHaveTextContent('새 방문은 만들지 않았습니다');
    expect(kit.calls.every(call=>call.method==='GET')).toBe(true);
    expect(kit.calls.some(call=>call.path.includes('/sale-cart'))).toBe(false);
  });
  it('조회 실패 뒤 같은 예약을 다시 확인할 수 있다',async()=>{
    let attempts=0;
    const kit=setup(()=>++attempts===1?network():[linked]);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button',{name:'다시 확인'}));
    expect(await screen.findByText('예약 방문 청구')).toBeInTheDocument();
    expect(kit.calls.every(call=>call.method==='GET')).toBe(true);
  });
  it('장바구니의 고객 연결이 다르면 내용을 표시하지 않는다',async()=>{
    const kit=setup(()=>[linked],bundle({visit:{appointment_id:appointment},cart:{customer_id:uid(99)},lines:[cartLine({description_snapshot:'표시하면 안 되는 청구'})]}));
    await waitFor(()=>expect(kit.calls.some(call=>call.path.includes('/sale-cart'))).toBe(true));
    await screen.findByText(/장바구니 조회/);
    expect(screen.queryByText('표시하면 안 되는 청구')).not.toBeInTheDocument();
  });
});
