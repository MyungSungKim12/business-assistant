import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { DataGrid, DateField, ErrorState, LoadingState, type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { ExportButton } from '../../lib/io/ExportButton';
import { confirm } from '@business-assistant/react-ui';
import { commissionApi, type CommissionPreview } from './commissionApi';
import { newOperationId } from '../sales/format';
import { buildComparison, comparisonExportColumns, previousPeriod, staffBars } from './managementCompare';
import { centsToText } from '../sales/format';
import { profitApi, type ProfitSnapshot } from './profitApi';
import './management.css';

const money = z.union([z.string(), z.number()]).transform(String);
export const managementPreviewSchema = z.object({
  organization_id: z.string(), from_date: z.string(), to_date: z.string(),
  recorded_income: money, recorded_expense: money, recorded_net: money, transaction_count: z.number(), visit_receipts: money, visit_refunds: money,
  inventory_cogs: money, inventory_cost_unknown_units: z.number().int().nonnegative(), recorded_tax_expense: money, operating_profit_before_commission_tax: money.nullable(),
  commission_settlement_complete:z.boolean(),commission_expense:money.nullable(),operating_profit_after_commission_before_tax:money.nullable(),operating_profit_after_recorded_tax:money.nullable(),
  staff_sales_basis: z.array(z.object({ staff_id: z.string().nullable(), staff_name_snapshot: z.string(), line_count: z.number(), gross_line_total: money })),
  is_final_profit: z.boolean(), excluded_costs: z.array(z.string()), staff_basis_is_commission: z.boolean(),
});
export type ManagementPreview = z.infer<typeof managementPreviewSchema>;
type StaffRow = ManagementPreview['staff_sales_basis'][number];

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const DAY = 86_400_000;
/** 조회 기간 검사(서버와 같은 규칙): 시작 ≤ 종료, 최대 366일. */
export function validPeriod(from: string | null, to: string | null): boolean {
  if (!from || !to) return false;
  const days = (Date.parse(to) - Date.parse(from)) / DAY;
  return Number.isFinite(days) && days >= 0 && days <= 366;
}
export function formatWon(raw: string): string {
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return '금액 확인 필요';
  return `${amount.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`;
}
const excludedCostLabel: Record<string, string> = { staff_commissions: '직원 수당 미확정', tax: '세금 미반영', unrecorded_taxes: '미기록 세금 확인 불가' };

const columns: Column<StaffRow>[] = [
  { key: 'staff', header: '담당자', width: 180, value: (row) => row.staff_name_snapshot || '담당 미지정' },
  { key: 'lines', header: '항목 수', width: 80, value: (row) => row.line_count },
  { key: 'total', header: '판매 항목 총액', width: 140, value: (row) => Number(row.gross_line_total), render: (row) => formatWon(row.gross_line_total) },
  { key: 'state', header: '확정 여부', width: 100, value: () => '수당 미확정' },
];

const staffExportColumns = [
  { header: '담당자', width: 18, value: (row: StaffRow) => row.staff_name_snapshot || '담당 미지정' },
  { header: '항목 수', type: 'number' as const, width: 10, value: (row: StaffRow) => row.line_count },
  { header: '판매 항목 총액(원)', type: 'number' as const, width: 18, value: (row: StaffRow) => Number(row.gross_line_total) },
  { header: '확정 여부', width: 12, value: () => '수당 미확정' },
];

/** 이번 기간과 같은 길이의 이전 기간을 나란히 비교한다. */
function ComparisonSection({ result, previous, previousFailed }: { result: ManagementPreview; previous: ManagementPreview | null; previousFailed: boolean }) {
  const summary = (preview: ManagementPreview) => ({ income: preview.recorded_income, expense: preview.recorded_expense, net: preview.recorded_net, receipts: preview.visit_receipts, refunds: preview.visit_refunds });
  const rows = buildComparison(summary(result), previous ? summary(previous) : null);
  const peak = rows.reduce((max, row) => Math.max(max, Math.abs(Number(row.current)), Math.abs(Number(row.previous ?? 0n))), 0);
  const width = (value: bigint | null) => (value === null || peak === 0 ? 0 : Math.max(1, (Math.abs(Number(value)) / peak) * 100));
  return (
    <section className="management-compare" aria-label="이전 기간 비교">
      <header>
        <h2>이전 기간 비교</h2>
        <span className="muted">{previous ? `이전 기간 ${previous.from_date} ~ ${previous.to_date}` : '이전 기간을 불러오지 못했습니다'}</span>
        <ExportButton title="수지 비교" label="비교 내보내기" columns={comparisonExportColumns} rows={rows} />
      </header>
      {previousFailed && <p className="muted">이전 기간 데이터를 불러오지 못해 이번 기간만 표시합니다. 조회를 다시 눌러 보세요.</p>}
      <table>
        <caption className="visually-hidden">이번 기간과 이전 기간 수지 비교</caption>
        <thead><tr><th>항목</th><th>이번 기간</th><th>이전 기간</th><th>변화</th><th aria-hidden="true">막대</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.metric}>
              <td>{row.label}</td>
              <td>{formatWon(centsToText(row.current))}</td>
              <td>{row.previous === null ? '-' : formatWon(centsToText(row.previous))}</td>
              <td data-testid={`change-${row.metric}`}>{row.change}</td>
              <td aria-hidden="true" className="management-compare__bars">
                <i className="management-bar management-bar--now" style={{ width: `${width(row.current)}%` }} />
                <i className="management-bar management-bar--before" style={{ width: `${width(row.previous)}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** 담당자별 판매 항목 총액 막대(총액 큰 순). 수당 확정액이 아니다. */
function StaffChart({ rows }: { rows: StaffRow[] }) {
  const bars = staffBars(rows);
  if (bars.length === 0) return null;
  return (
    <ul className="management-staff-chart" aria-label="담당자별 판매 항목 총액 막대">
      {bars.map((bar) => (
        <li key={bar.key} title={`${bar.name} ${formatWon(String(bar.amount))}`}>
          <span className="management-staff-chart__name">{bar.name}</span>
          <span className="management-staff-chart__track"><i style={{ width: `${bar.share}%` }} /></span>
          <span className="management-staff-chart__value">{formatWon(String(bar.amount))}</span>
        </li>
      ))}
    </ul>
  );
}

export interface ManagementPageProps { api: ApiClient; organizationId: string; readOnly: boolean }

/** 운영 수지 · 담당 매출 근거(분석·경영 실험실 미리보기). 관리자(owner/admin)만 조회한다. 확정 손익이 아니다. */
export function ManagementPage({ api, organizationId, readOnly }: ManagementPageProps) {
  const today = new Date();
  const [from, setFrom] = useState<string | null>(localDate(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState<string | null>(localDate(today));
  const [result, setResult] = useState<ManagementPreview | null>(null);
  /** 같은 길이의 이전 기간. 불러오지 못하면 null(이번 기간만 보여 준다). */
  const [previous, setPrevious] = useState<ManagementPreview | null>(null);
  const [previousFailed, setPreviousFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [periodError, setPeriodError] = useState('');
  const [commissionPreview,setCommissionPreview]=useState<CommissionPreview|null>(null);
  const [commissionBusy,setCommissionBusy]=useState(false);
  const [commissionError,setCommissionError]=useState('');
  const [commissionStaff,setCommissionStaff]=useState<Array<{id:string;name:string;is_active:boolean}>>([]);
  const [attributionDrafts,setAttributionDrafts]=useState<Record<string,{staff_id:string;reason:string}>>({});
  const [attributionBusyLine,setAttributionBusyLine]=useState<string|null>(null);
  const commissionOperation=useRef<{period:string;id:string}|null>(null);
  const attributionOperations=useRef(new Map<string,string>());
  const [profitSnapshots,setProfitSnapshots]=useState<ProfitSnapshot[]>([]);
  const [profitConfirmed,setProfitConfirmed]=useState(false);
  const [profitReason,setProfitReason]=useState('');
  const [profitBusy,setProfitBusy]=useState(false);
  const [profitError,setProfitError]=useState('');
  const profitOperation=useRef<{key:string;id:string}|null>(null);

  const refresh = useCallback(async (start: string | null, end: string | null) => {
    if (!start || !end || !validPeriod(start, end)) { setPeriodError('시작일과 종료일을 366일 이내의 YYYY-MM-DD로 입력하세요.'); return; }
    setPeriodError(''); setError(''); setLoading(true);
    try {
      const before = previousPeriod(start, end);
      const fetchPreview = (a: string, b: string) => api.call('GET', `/organizations/${organizationId}/management-preview?from_date=${a}&to_date=${b}`, managementPreviewSchema);
      const [current, prior] = await Promise.allSettled([fetchPreview(start, end), before ? fetchPreview(before.from, before.to) : Promise.reject(new Error('no previous period'))]);
      if (current.status === 'rejected') throw current.reason;
      const preview = current.value;
      // 이전 기간도 확정 표시가 붙은 응답이면 쓰지 않는다.
      const priorOk = prior.status === 'fulfilled' && !prior.value.is_final_profit;
      setPrevious(priorOk ? prior.value : null);
      setPreviousFailed(!priorOk);
      // 확정 손익·수당 확정으로 표시된 응답은 이 화면이 보여 줄 수 없다(Python 클라이언트와 같은 방어).
      if (preview.is_final_profit) throw new Error('unexpected finalization');
      setResult(preview);
      setProfitConfirmed(false);setProfitError('');
      try{setProfitSnapshots(await profitApi.list(api,organizationId,start,end));}
      catch{setProfitSnapshots([]);setProfitError('확정 이력을 불러오지 못했습니다. 089 SQL 적용 상태를 확인하세요.');}
    } catch (failure) {
      setResult(null);
      setPrevious(null);
      setPreviousFailed(false);
      setError((failure as { status?: number }).status === 403 ? '관리자만 조회할 수 있습니다.' : '조회하지 못했습니다. 서버와 최신 경영 SQL 적용 상태를 확인하고 다시 시도하세요.');
    } finally { setLoading(false); }
  }, [api, organizationId]);

  const canFinalize=(result!==null&&result.from_date===from&&result.to_date===to&&result.inventory_cost_unknown_units===0&&result.commission_settlement_complete&&result.operating_profit_after_recorded_tax!==null&&result.to_date<localDate(new Date()));
  const finalizeProfit=async()=>{
    if(!result||!canFinalize||!profitConfirmed||profitBusy)return;
    const key=JSON.stringify([organizationId,result.from_date,result.to_date,profitReason.trim()]);
    if(!profitOperation.current||profitOperation.current.key!==key)profitOperation.current={key,id:newOperationId()};
    setProfitBusy(true);setProfitError('');
    try{
      const saved=await profitApi.finalize(api,organizationId,{from_date:result.from_date,to_date:result.to_date,operation_id:profitOperation.current.id,confirmed_complete:true,reason:profitReason.trim()});
      profitOperation.current=null;setProfitSnapshots(current=>[saved,...current.filter(item=>item.id!==saved.id)]);setProfitConfirmed(false);
    }catch(error){setProfitError((error as {status?:number}).status===409?'확정 자료가 바뀌었거나 수정 사유가 필요합니다. 다시 조회해 주세요.':'손익을 확정하지 못했습니다. 재시도하면 같은 요청 ID로 결과를 확인합니다.');}
    finally{setProfitBusy(false);}
  };
  const loadCommissionPreview=async(start:string,end:string)=>{
    setCommissionBusy(true);setCommissionError('');
    try{
      const [preview,staff]=await Promise.all([commissionApi.previewSettlement(api,organizationId,{from_date:start,to_date:end}),commissionApi.listStaff(api,organizationId)]);
      setCommissionPreview(preview);setCommissionStaff(staff.filter(person=>person.is_active));
      setAttributionDrafts(current=>Object.fromEntries(preview.lines.filter(line=>line.staff_id===null||line.attribution_override_version>0).map(line=>[line.sale_line_id,current[line.sale_line_id]??{staff_id:line.staff_id??'',reason:''}])));
    }catch(e){setCommissionError((e as {status?:number}).status===409?'이미 확정된 기간과 겹칩니다.':'수당 미리보기를 불러오지 못했습니다. 기간과 079 SQL 적용 상태를 확인하세요.');setCommissionPreview(null);}
    finally{setCommissionBusy(false);}
  };
  const saveAttribution=async(line:CommissionPreview['lines'][number])=>{
    const draft=attributionDrafts[line.sale_line_id];if(!draft?.staff_id||!draft.reason.trim()||attributionBusyLine)return;
    const key=JSON.stringify([organizationId,line.sale_line_id,draft.staff_id,line.attribution_override_version,draft.reason.trim()]);
    if(!attributionOperations.current.has(key))attributionOperations.current.set(key,newOperationId());
    setAttributionBusyLine(line.sale_line_id);setCommissionError('');
    try{
      await commissionApi.assignAttribution(api,organizationId,line.sale_line_id,{staff_id:draft.staff_id,expected_version:line.attribution_override_version,reason:draft.reason.trim(),operation_id:attributionOperations.current.get(key)!});
      attributionOperations.current.delete(key);await loadCommissionPreview(from!,to!);
    }catch(e){setCommissionError((e as {status?:number}).status===409?'다른 관리자가 담당 정보를 바꿨거나 정산이 확정되었습니다. 미리보기를 다시 조회하세요.':'담당 보정을 저장하지 못했습니다. 사유와 SQL 093 적용 상태를 확인하세요.');}
    finally{setAttributionBusyLine(null);}
  };

  // 화면을 열거나 조직이 바뀔 때 기본 기간으로 한 번 조회한다. 기간을 바꾼 뒤에는 조회 버튼으로 다시 조회한다.
  useEffect(() => {
    if (!readOnly) void refresh(from, to);
  }, [readOnly, organizationId]);

  if (readOnly) {
    return (
      <section className="management-page">
        <div className="page-toolbar"><div><h1>운영 수지 · 담당 매출 근거</h1></div></div>
        <p role="alert" className="form-error">관리자(소유자·관리자)만 조회할 수 있습니다.</p>
      </section>
    );
  }

  return (
    <section className="management-page">
      <div className="page-toolbar"><div><h1>운영 수지 · 담당 매출 근거</h1><p className="muted">기록된 원장 기준의 읽기 전용 미리보기입니다.</p></div></div>
      <div className="management-filters">
        <label>시작일<DateField aria-label="시작일" value={from} onChange={value=>{setFrom(value);setCommissionPreview(null);}} /></label>
        <label>종료일<DateField aria-label="종료일" value={to} onChange={value=>{setTo(value);setCommissionPreview(null);}} /></label>
        <button type="button" className="primary-button" disabled={loading} onClick={() => void refresh(from, to)}>조회</button>
      </div>
      <section className="management-commission" aria-labelledby="commission-settlement-title">
        <h2 id="commission-settlement-title">직원 수당 정산</h2>
        <p className="muted">수납·회원권 사용·환불 발생일 기준 미리보기입니다. 확정된 기간은 다시 수정할 수 없습니다. 오늘 이후 기간은 확정할 수 없습니다.</p>
        <div className="management-actions">
          <button type="button" disabled={commissionBusy||!from||!to} onClick={()=>{if(from&&to)void loadCommissionPreview(from,to);}}>수당 미리보기</button>
          {commissionPreview&&<button type="button" className="primary-button" disabled={commissionBusy||commissionPreview.lines.some(line=>line.warning!==null)} onClick={async()=>{const reviewed=commissionPreview;if(!await confirm({title:'수당 기간 확정',message:`${reviewed.from_date}부터 ${reviewed.to_date}까지의 수당을 확정합니다. 확정 후에는 수정할 수 없습니다.`,confirmLabel:'수당 확정'}))return;setCommissionBusy(true);setCommissionError('');const period=`${reviewed.from_date}:${reviewed.to_date}`;if(!commissionOperation.current||commissionOperation.current.period!==period)commissionOperation.current={period,id:newOperationId()};try{await commissionApi.confirmSettlement(api,organizationId,{from_date:reviewed.from_date,to_date:reviewed.to_date,operation_id:commissionOperation.current.id});commissionOperation.current=null;setCommissionPreview(null);await refresh(from,to);}catch{setCommissionError('확정 결과를 확인할 수 없습니다. 같은 미리보기를 다시 확정하면 이전 요청을 안전하게 재확인합니다.');}finally{setCommissionBusy(false);}}}>기간 확정</button>}
        </div>
        {commissionError&&<p role="alert" className="form-error">{commissionError}</p>}
        {commissionBusy&&<p role="status">수당 정산을 처리하고 있습니다.</p>}
        {commissionPreview&&<>
          <p className="management-summary">{commissionPreview.from_date} ~ {commissionPreview.to_date} · 수당 합계 {formatWon(commissionPreview.lines.reduce((sum,line)=>sum+Number(line.commission_amount),0).toString())} · {commissionPreview.lines.length}건</p>
          <DataGrid rows={commissionPreview.lines} columns={[
            {key:'staff',header:'직원',width:130,value:r=>r.staff_name_snapshot},
            {key:'type',header:'구분',width:90,value:r=>r.event_kind==='refund'?'환불 조정':r.event_kind==='wallet'?'회원권 사용':'수납'},
            {key:'net',header:'수납 배분액',width:120,value:r=>Number(r.net_paid_amount),render:r=>formatWon(r.net_paid_amount)},
            {key:'rate',header:'수당률',width:80,value:r=>r.rule_rate_basis_points===null?'미설정':`${(r.rule_rate_basis_points/100).toFixed(2)}%`},
            {key:'commission',header:'수당',width:100,value:r=>Number(r.commission_amount),render:r=>formatWon(r.commission_amount)},
            {key:'warning',header:'확인',width:150,value:r=>r.warning??'확인'},
          ]} rowKey={r=>`${r.source_event_id}:${r.sale_line_id}`} ariaLabel="직원 수당 정산 미리보기" emptyText="해당 기간 수당 자료가 없습니다." />
          {commissionPreview.lines.filter(line=>line.staff_id===null||line.attribution_override_version>0).map(line=>{
            const draft=attributionDrafts[line.sale_line_id]??{staff_id:line.staff_id??'',reason:''};
            return <fieldset className="management-attribution" key={line.sale_line_id}><legend>{line.staff_id===null?'담당 누락 보정':'담당 귀속 수정'} · {line.sale_line_id.slice(0,8)}</legend>
              <label>귀속 직원<select aria-label={`귀속 직원 ${line.sale_line_id}`} value={draft.staff_id} disabled={attributionBusyLine===line.sale_line_id} onChange={event=>{const staffId=event.currentTarget.value;setAttributionDrafts(current=>({...current,[line.sale_line_id]:{...(current[line.sale_line_id]??draft),staff_id:staffId}}));}}><option value="">직원 선택</option>{commissionStaff.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
              <label>보정 사유<input aria-label={`보정 사유 ${line.sale_line_id}`} maxLength={500} value={draft.reason} disabled={attributionBusyLine===line.sale_line_id} onChange={event=>{const reason=event.currentTarget.value;setAttributionDrafts(current=>({...current,[line.sale_line_id]:{...(current[line.sale_line_id]??draft),reason}}));}} placeholder="예: 결제 등록 시 담당자 선택 누락" /></label>
              <button type="button" disabled={!draft.staff_id||!draft.reason.trim()||attributionBusyLine!==null||commissionBusy} onClick={()=>void saveAttribution(line)}>{attributionBusyLine===line.sale_line_id?'저장 중…':line.staff_id===null?'담당 보정':'귀속 변경'}</button>
            </fieldset>;
          })}
          {commissionPreview.lines.some(line=>line.warning!==null)&&<p className="form-error">직원 또는 규칙 미지정 항목이 있습니다. 담당·수당 규칙을 보완한 뒤 다시 미리보기하세요.</p>}
        </>}
      </section>
      <p className="management-warning">최종 손익이 아닙니다. 기록된 세금 지출만 구분해 표시하며, 신고·납부할 세금의 누락 여부를 판정하거나 세액을 계산하지 않습니다. 매입 단가가 없는 과거 재고도 별도로 표시합니다.</p>
      {periodError && <p role="alert" className="form-error">{periodError}</p>}
      {error && <ErrorState message={error} onRetry={() => void refresh(from, to)} />}
      {loading && <LoadingState label="기록된 수지를 조회하는 중…" />}
      {result && !loading && (
        <>
          <p className="management-summary">기록된 수입 {formatWon(result.recorded_income)} · 지출 {formatWon(result.recorded_expense)} · 순액 {formatWon(result.recorded_net)}</p>
          <p className="management-summary">방문 수납 {formatWon(result.visit_receipts)} · 방문 환불 {formatWon(result.visit_refunds)} · 원장 거래 {result.transaction_count}건</p>
          <p className="management-summary">상품·시술 원가 {formatWon(result.inventory_cogs)}{result.inventory_cost_unknown_units ? ` · 원가 미확인 ${result.inventory_cost_unknown_units}개` : ''}</p>
          <p className="management-summary">원가 반영 잔액(수당 전·세전) {result.operating_profit_before_commission_tax===null?'원가 미확인 항목이 있어 계산할 수 없습니다.':formatWon(result.operating_profit_before_commission_tax)}</p>
          <p className="management-summary">{result.commission_settlement_complete?`확정 수당 ${formatWon(result.commission_expense??'0')} 차감 후(세전) ${result.operating_profit_after_commission_before_tax===null?'원가 미확인':formatWon(result.operating_profit_after_commission_before_tax)}`:'확정 수당을 차감할 수 있도록 조회 기간 전체의 정산을 완료하세요.'}</p>
          <p className="management-summary">기록된 세금 지출 {formatWon(result.recorded_tax_expense)} · 수당 차감 후 잔액(기록 세금 반영) {result.operating_profit_after_recorded_tax===null?'원가 또는 수당 미확인':formatWon(result.operating_profit_after_recorded_tax)}</p>
          <section className="management-finalization" aria-labelledby="management-finalization-title">
            <h2 id="management-finalization-title">기간 손익 확정</h2>
            <p className="muted">확정하면 이 시점의 기록값을 새 revision 스냅샷으로 보존합니다. 원장 입력이 완전한지 확인한 관리자 기준의 경영 자료이며, 공식 회계·세무 신고서가 아닙니다.</p>
            {!canFinalize&&<p className="muted">원가와 기간 전체 수당 정산을 완료해야 손익을 확정할 수 있습니다. 과거 날짜로 끝나는 기간만 확정할 수 있습니다.</p>}
            {canFinalize&&<>
              {profitSnapshots.length>0&&<label>수정 사유<input aria-label="손익 수정 사유" maxLength={500} value={profitReason} onChange={event=>setProfitReason(event.currentTarget.value)} placeholder="기존 확정본이 있으면 수정 사유를 입력하세요" /></label>}
              <label className="management-confirmation"><input aria-label="원장 완전성 확인" type="checkbox" checked={profitConfirmed} disabled={profitBusy} onChange={event=>setProfitConfirmed(event.currentTarget.checked)} />기간 내 수입·지출, 급여·수당, 세금과 재고 원가가 모두 입력되었음을 확인합니다.</label>
              <button type="button" className="primary-button" disabled={!profitConfirmed||profitBusy||(profitSnapshots.length>0&&!profitReason.trim())} onClick={()=>void finalizeProfit()}>{profitBusy?'손익을 확정하는 중…':'손익 확정'}</button>
            </>}
            {profitError&&<p role="alert" className="form-error">{profitError}</p>}
            {profitSnapshots.length>0&&<ol aria-label="손익 확정 이력">{profitSnapshots.map(item=><li key={item.id}><strong>{item.revision}차 확정</strong> · {formatWon(item.result.operating_profit_after_recorded_tax)} · {new Date(item.confirmed_at).toLocaleString('ko-KR')}{item.reason?` · ${item.reason}`:''}</li>)}</ol>}
          </section>
          <ComparisonSection result={result} previous={previous} previousFailed={previousFailed} />
          <StaffChart rows={result.staff_sales_basis} />
          <div className="management-actions"><ExportButton title="담당자별 판매 근거" label="담당자별 내보내기" columns={staffExportColumns} rows={result.staff_sales_basis} disabled={result.staff_sales_basis.length === 0} /></div>
          <DataGrid rows={result.staff_sales_basis} columns={columns} rowKey={(row) => `${row.staff_id ?? 'none'}:${row.staff_name_snapshot}`} ariaLabel="담당자별 판매 근거" emptyText="해당 기간에 담당자별 판매 항목이 없습니다." />
          <p className="muted">조회 완료 · 해당 기간에 기록된 원장 기준{result.excluded_costs.length ? ` · 확인 제한: ${result.excluded_costs.map((item) => excludedCostLabel[item] ?? item).join(', ')}` : ''}</p>
        </>
      )}
    </section>
  );
}
