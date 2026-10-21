import type { CommissionHistory } from './commissionApi';

export interface CommissionPerformanceRow {
  staff_id:string|null;
  staff_name:string;
  line_count:number;
  refund_count:number;
  net_paid_amount:string;
  commission_amount:string;
}

/** Aggregates one confirmed, immutable settlement; refunds remain signed adjustments. */
export function aggregateCommissionPerformance(history:CommissionHistory,settlementId:string):CommissionPerformanceRow[]{
  const settlement=history.find(item=>item.settlement.id===settlementId);
  if(!settlement)return [];
  const rows=new Map<string,CommissionPerformanceRow>();
  const paid=new Map<string,bigint>(),commission=new Map<string,bigint>();
  for(const line of settlement.lines){
    const key=line.staff_id??`unassigned:${line.staff_name_snapshot}`;
    const current=rows.get(key)??{staff_id:line.staff_id,staff_name:line.staff_name_snapshot.trim()||'담당 미지정',line_count:0,refund_count:0,net_paid_amount:'0',commission_amount:'0'};
    current.line_count+=1;
    if(line.event_kind==='refund')current.refund_count+=1;
    rows.set(key,current);
    paid.set(key,(paid.get(key)??0n)+BigInt(line.net_paid_amount));
    commission.set(key,(commission.get(key)??0n)+BigInt(line.commission_amount));
  }
  return [...rows.entries()].map(([key,row])=>({...row,net_paid_amount:String(paid.get(key)??0n),commission_amount:String(commission.get(key)??0n)}))
    .sort((a,b)=>BigInt(a.commission_amount)>BigInt(b.commission_amount)?-1:BigInt(a.commission_amount)<BigInt(b.commission_amount)?1:a.staff_name.localeCompare(b.staff_name,'ko-KR'));
}
