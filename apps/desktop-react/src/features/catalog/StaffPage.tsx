import { useCallback, useEffect, useState } from 'react';
import { DataGrid, ErrorState, LoadingState, notify, type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { StaffAvailabilityDialog } from '../appointment-resources/StaffAvailabilityDialog';
import { resourceApi } from '../appointment-resources/api';
import type { AppointmentStaffRow } from '../appointment-resources/schemas';
import './catalog.css';
import { StaffProfileDialog } from './StaffProfileDialog';
import { CommissionRulesDialog } from './CommissionRulesDialog';
import { useDraftProtection } from '../../app/DraftBoundary';
import { commissionApi, type CommissionHistory } from '../management/commissionApi';
import { aggregateCommissionPerformance } from '../management/commissionPerformance';

function money(raw:string){return `${BigInt(raw).toLocaleString('ko-KR')}원`;}

const columns: Column<AppointmentStaffRow>[] = [
  { key: 'name', header: '직원', width: 220, value: (row) => row.name },
  { key: 'active', header: '예약 담당', width: 80, value: (row) => (row.is_active ? '사용' : '중지') },
];

export interface StaffPageProps { api: ApiClient; organizationId: string; readOnly: boolean }

/** 직원 목록·근무/휴무 관리와 확정 수납·수당 집계를 제공한다. */
export function StaffPage({ api, organizationId, readOnly }: StaffPageProps) {
  const [rows, setRows] = useState<AppointmentStaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<AppointmentStaffRow | null>(null);
  const [editing,setEditing]=useState<AppointmentStaffRow|null>(null);
  const [commissions,setCommissions]=useState(false);
  const [settlementHistory,setSettlementHistory]=useState<CommissionHistory>([]);
  const [commissionSettlementId,setCommissionSettlementId]=useState('');
  const [settlementHistoryLoading,setSettlementHistoryLoading]=useState(true);
  const [settlementHistoryError,setSettlementHistoryError]=useState('');
  useDraftProtection(Boolean(name.trim()),busy);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try { setRows(await resourceApi.listStaff(api, organizationId)); }
    catch { setLoadError('직원 목록을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [api, organizationId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(()=>{let alive=true;setSettlementHistoryLoading(true);setSettlementHistoryError('');void commissionApi.history(api,organizationId).then(rows=>{if(alive)setSettlementHistory(rows);}).catch(()=>{if(alive){setSettlementHistory([]);setSettlementHistoryError('확정 수당 집계를 불러오지 못했습니다. 연결과 079 SQL 적용 상태를 확인하고 다시 시도하세요.');}}).finally(()=>{if(alive)setSettlementHistoryLoading(false);});return()=>{alive=false;};},[api,organizationId]);

  async function add() {
    if(busy||readOnly)return;
    const trimmed = name.trim();
    if (!trimmed) { setError('직원 이름을 입력하세요.'); return; }
    setBusy(true);
    try {
      const created = await resourceApi.createStaff(api, organizationId, { name: trimmed });
      setRows((current) => [...current, created]); setName(''); setError(''); setSelectedId(created.id);
      notify.success('직원을 추가했습니다.');
    } catch { setError('직원 추가에 실패했습니다. 입력은 유지됩니다.'); }
    finally { setBusy(false); }
  }

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const settlementRows=settlementHistory.flatMap(({settlement,lines})=>lines.map(line=>({...line,from_date:settlement.from_date,to_date:settlement.to_date})));
  const latestSettlement=settlementHistory.reduce((latest,item)=>!latest||item.settlement.to_date>latest.settlement.to_date?item:latest,null as CommissionHistory[number]|null);
  const activeSettlementId=settlementHistory.some(item=>item.settlement.id===commissionSettlementId)?commissionSettlementId:latestSettlement?.settlement.id??'';
  const performanceRows=aggregateCommissionPerformance(settlementHistory,activeSettlementId);
  const performanceColumns:Column<(typeof performanceRows)[number]>[]=[
    {key:'staff',header:'직원',width:160,value:r=>r.staff_name},
    {key:'lines',header:'정산 항목',width:90,value:r=>r.line_count},
    {key:'refunds',header:'환불 조정',width:90,value:r=>r.refund_count},
    {key:'paid',header:'수납 배분액',width:140,value:r=>Number(r.net_paid_amount),render:r=>money(r.net_paid_amount)},
    {key:'commission',header:'확정 수당',width:130,value:r=>Number(r.commission_amount),render:r=>money(r.commission_amount)},
  ];
  const settlementColumns:Column<(typeof settlementRows)[number]>[]=[
    {key:'period',header:'정산 기간',width:180,value:r=>`${r.from_date} ~ ${r.to_date}`},
    {key:'staff',header:'직원',width:120,value:r=>r.staff_name_snapshot},
    {key:'event',header:'내역',width:90,value:r=>r.event_kind==='refund'?'환불 조정':r.event_kind==='wallet'?'회원권 사용':'수납'},
    {key:'paid',header:'수납 배분액',width:120,value:r=>Number(r.net_paid_amount),render:r=>`${Number(r.net_paid_amount).toLocaleString('ko-KR')}원`},
    {key:'commission',header:'수당',width:100,value:r=>Number(r.commission_amount),render:r=>`${Number(r.commission_amount).toLocaleString('ko-KR')}원`},
  ];
  return (
    <section className="catalog-page staff-page">
      <div className="page-toolbar">
        <div><h1>직원관리</h1><p className="muted">예약 담당자와 근무 일정을 관리합니다.</p></div>
        <button type="button" disabled={!selected} onClick={() => selected && setOpen(selected)}>근무시간·휴무</button>
        {!readOnly&&<button type="button" onClick={()=>setCommissions(true)}>수당 규칙</button>}
        {!readOnly&&<button type="button" disabled={!selected||busy} onClick={()=>selected&&setEditing(selected)}>직원 정보 수정</button>}
      </div>
      {loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : loading ? <LoadingState /> : (
        <DataGrid rows={rows} columns={columns} rowKey={(row) => row.id} selectedKey={selectedId} onSelect={(row) => setSelectedId(row.id)} onActivate={setOpen} ariaLabel="직원 목록" storageKey="staff-grid" emptyText="등록된 직원이 없습니다." />
      )}
      {!readOnly && (
        <div className="inline-form" aria-label="직원 추가">
          <label>새 직원 이름<input value={name} onChange={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void add(); }} /></label>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void add()}>직원 추가</button>
        </div>
      )}
      {error && <p role="alert" className="form-error">{error}</p>}
      <section aria-label="직원 성과 집계"><h2>직원 성과 집계</h2><p className="muted">확정 원장의 수납 배분액과 수당을 직원별로 합산합니다. 운영 실적 요약이며 급여·세금 또는 인사 평가를 뜻하지 않습니다.</p>
        {settlementHistoryLoading&&<p role="status">확정 정산을 불러오는 중…</p>}
        {settlementHistoryError&&<p role="alert" className="form-error">{settlementHistoryError}</p>}
        {settlementHistory.length>0&&<label>확정 정산 기간<select aria-label="성과 조회 정산 기간" value={activeSettlementId} onChange={event=>setCommissionSettlementId(event.currentTarget.value)}>{[...settlementHistory].sort((a,b)=>b.settlement.to_date.localeCompare(a.settlement.to_date)).map(item=><option key={item.settlement.id} value={item.settlement.id}>{item.settlement.from_date} ~ {item.settlement.to_date}</option>)}</select></label>}
        {activeSettlementId&&<DataGrid rows={performanceRows} columns={performanceColumns} rowKey={row=>row.staff_id??row.staff_name} ariaLabel="직원별 확정 성과" emptyText="이 정산 기간에 확정 항목이 없습니다."/>}
        {!settlementHistoryLoading&&!settlementHistoryError&&!settlementHistory.length&&<p className="muted">확정된 정산이 없습니다. 관리자에게 수당 규칙과 정산 완료 여부를 확인하세요.</p>}
      </section>
      <section aria-label="확정 수당 내역"><h2>확정 수당 내역</h2><p className="muted">관리자는 전체 직원, 연결된 직원 계정은 본인 항목만 표시됩니다.</p><DataGrid rows={settlementRows} columns={settlementColumns} rowKey={row=>row.id} ariaLabel="확정 수당 내역" emptyText="확정된 수당 내역이 없습니다." /></section>
      {open && <StaffAvailabilityDialog api={api} organizationId={organizationId} staff={open} readOnly={readOnly} onClose={() => setOpen(null)} />}
      {editing&&<StaffProfileDialog key={editing.id} api={api} organizationId={organizationId} staff={editing} linkedUserIds={rows.flatMap(row=>row.auth_user_id?[row.auth_user_id]:[])} onSaved={saved=>{setRows(old=>old.map(row=>row.id===saved.id?saved:row));setEditing(null);void load();}} onClose={()=>{setEditing(null);void load();}}/>}
      {commissions&&<CommissionRulesDialog api={api} organizationId={organizationId} onClose={()=>setCommissions(false)}/>}
    </section>
  );
}
