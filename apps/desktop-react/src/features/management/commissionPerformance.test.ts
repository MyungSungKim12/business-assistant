import { describe, expect, it } from 'vitest';
import { aggregateCommissionPerformance } from './commissionPerformance';

describe('aggregateCommissionPerformance',()=>{
  it('선택한 확정 정산만 직원별로 모으고 환불 조정을 합산한다',()=>{
    const history=[
      {settlement:{id:'first',organization_id:'org',from_date:'2026-09-01',to_date:'2026-09-30',status:'confirmed' as const,total_commission:'0'},lines:[
        {id:'a',source_event_id:'e1',event_kind:'receipt' as const,sale_line_id:'l1',staff_id:'staff-1',staff_name_snapshot:'김담당',commission_scope:'service' as const,net_paid_amount:'90000',commission_amount:'9000'},
        {id:'b',source_event_id:'e2',event_kind:'wallet' as const,sale_line_id:'l2',staff_id:'staff-1',staff_name_snapshot:'김담당',commission_scope:'product' as const,net_paid_amount:'30000',commission_amount:'3000'},
        {id:'c',source_event_id:'e3',event_kind:'refund' as const,sale_line_id:'l1',staff_id:'staff-1',staff_name_snapshot:'김담당',commission_scope:'service' as const,net_paid_amount:'-20000',commission_amount:'-2000'},
      ]},
      {settlement:{id:'other',organization_id:'org',from_date:'2026-10-01',to_date:'2026-10-31',status:'confirmed' as const,total_commission:'0'},lines:[
        {id:'d',source_event_id:'e4',event_kind:'receipt' as const,sale_line_id:'l3',staff_id:'staff-2',staff_name_snapshot:'박담당',commission_scope:'service' as const,net_paid_amount:'50000',commission_amount:'5000'},
      ]},
    ];
    expect(aggregateCommissionPerformance(history,'first')).toEqual([{staff_id:'staff-1',staff_name:'김담당',line_count:3,refund_count:1,net_paid_amount:'100000',commission_amount:'10000'}]);
  });

  it('이름이 비어 있는 담당도 별도 집계 행으로 보존한다',()=>{
    const history=[{settlement:{id:'first',organization_id:'org',from_date:'2026-09-01',to_date:'2026-09-30',status:'confirmed' as const,total_commission:'0'},lines:[{id:'a',source_event_id:'e1',event_kind:'receipt' as const,sale_line_id:'l1',staff_id:null,staff_name_snapshot:'',commission_scope:'service' as const,net_paid_amount:'1000',commission_amount:'0'}]}];
    expect(aggregateCommissionPerformance(history,'first')[0]).toMatchObject({staff_id:null,staff_name:'담당 미지정',line_count:1,net_paid_amount:'1000'});
  });
});
