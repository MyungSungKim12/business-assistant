import { useEffect,useMemo,useState } from 'react';
import { DataGrid,LoadingState,Modal,Select,type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { useDraftProtection } from '../../app/DraftBoundary';
import { resourceApi } from '../appointment-resources/api';
import { catalogApi } from './api';
import type { CatalogProduct } from './schemas';
import { commissionApi,type CommissionRule } from '../management/commissionApi';
import { notify } from '@business-assistant/react-ui';

type Scope=CommissionRule['commission_scope'];
const initial=(scope:Scope='service')=>({staff_id:'',scope,service_id:'',product_id:'',rate:'',effective_from:new Date().toISOString().slice(0,10),effective_to:''});
const moneyRate=/^(?:\d{1,2}(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/;

export function CommissionRulesDialog({api,organizationId,onClose}:{api:ApiClient;organizationId:string;onClose:()=>void}){
 const [rules,setRules]=useState<CommissionRule[]>([]),[staff,setStaff]=useState<{id:string;name:string}[]>([]),[services,setServices]=useState<{id:string;name:string}[]>([]),[products,setProducts]=useState<CatalogProduct[]>([]);
 const [form,setForm]=useState(initial()),[endDate,setEndDate]=useState(new Date().toISOString().slice(0,10)),[selected,setSelected]=useState<string|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const dirty=Boolean(form.rate||form.staff_id||form.service_id||form.product_id);useDraftProtection(dirty,busy);
 async function load(){setLoading(true);setError('');try{const [r,s,v,p]=await Promise.all([commissionApi.list(api,organizationId),resourceApi.listStaff(api,organizationId),resourceApi.listServices(api,organizationId),catalogApi.listProducts(api,organizationId)]);setRules(r);setStaff(s.map(x=>({id:x.id,name:x.name})));setServices(v.map(x=>({id:x.id,name:x.name})));setProducts(p.filter(x=>x.is_active));}catch{setError('수당 규칙과 적용 대상을 불러오지 못했습니다. 069 SQL 적용 여부를 확인하고 다시 시도하세요.');}finally{setLoading(false);}}
 useEffect(()=>{void load();},[api,organizationId]);
 const selectedRule=rules.find(x=>x.id===selected&&x.is_active)??null;
 const targetOptions=useMemo(()=>form.scope==='service'?services:products.filter(x=>form.scope==='product'?x.kind==='product':x.kind==='membership').map(x=>({id:x.id,name:x.name})),[form.scope,services,products]);
 const columns:Column<CommissionRule>[]=[{key:'staff',header:'직원',width:100,value:r=>staff.find(x=>x.id===r.staff_id)?.name??'전체 직원'},{key:'target',header:'대상',width:160,value:r=>r.commission_scope==='service'?services.find(x=>x.id===r.service_id)?.name??'서비스':products.find(x=>x.id===r.product_id)?.name??'상품'},{key:'rate',header:'수당률',width:90,value:r=>`${(r.rate_basis_points/100).toFixed(2)}%`},{key:'basis',header:'산정 기준',width:100,value:r=>'수납 배분액'},{key:'period',header:'적용 기간',width:200,value:r=>`${r.effective_from} ~ ${r.effective_to??'종료 전'}`},{key:'state',header:'상태',width:80,value:r=>r.is_active?'사용':'종료'}];
 async function save(){if(busy)return;const rate=form.rate.trim();if(!moneyRate.test(rate)){setError('수당률은 0~100% 사이, 소수점 둘째 자리까지 입력하세요.');return;}const target=form.scope==='service'?form.service_id:form.product_id;if(!target){setError('수당 적용 대상을 선택하세요.');return;}if(form.effective_to&&form.effective_to<form.effective_from){setError('종료일은 시작일 이후여야 합니다.');return;}setBusy(true);setError('');try{const saved=await commissionApi.create(api,organizationId,{staff_id:form.staff_id||null,commission_scope:form.scope,service_id:form.scope==='service'?target:null,product_id:form.scope==='service'?null:target,rate_basis_points:Math.round(Number(rate)*100),effective_from:form.effective_from,effective_to:form.effective_to||null});setRules(x=>[saved,...x]);setForm(initial(form.scope));notify.success('수당 규칙을 저장했습니다.');}catch(e){setError((e as {status?:number}).status===409?'같은 직원·대상의 적용 기간이 겹칩니다. 기존 규칙 종료일을 먼저 설정하세요.':'저장하지 못했습니다. 입력을 확인하고 다시 시도하세요.');}finally{setBusy(false);}}
 async function end(){if(!selectedRule||busy)return;if(!endDate||endDate<selectedRule.effective_from){setError('종료일은 적용 시작일 이후여야 합니다.');return;}setBusy(true);setError('');try{const saved=await commissionApi.end(api,organizationId,selectedRule.id,{effective_to:endDate,expected_version:selectedRule.version});setRules(x=>x.map(r=>r.id===saved.id?saved:r));setSelected(null);notify.success('수당 규칙을 종료했습니다.');}catch{setError('규칙이 변경되었을 수 있습니다. 목록을 새로고침한 뒤 다시 확인하세요.');}finally{setBusy(false);}}
 return <Modal title="직원 수당 규칙" size="lg" onClose={onClose}>
  <p className="muted">실제 수납액을 항목별로 배분한 금액에 적용하는 비율입니다. 확정 급여 계산 전 정책을 등록하는 단계이며, 수당 명세·지급을 확정하지 않습니다.</p>
  {loading?<LoadingState label="수당 규칙을 불러오는 중…"/>:<>
   <DataGrid rows={rules} columns={columns} rowKey={r=>r.id} selectedKey={selected} onSelect={r=>setSelected(r.id)} ariaLabel="직원 수당 규칙" emptyText="등록된 수당 규칙이 없습니다."/>
   <div className="inline-form" aria-label="수당 규칙 등록">
    <label>적용 직원<Select aria-label="수당 적용 직원" value={form.staff_id} onChange={staff_id=>setForm(x=>({...x,staff_id}))} options={[{value:'',label:'전체 직원'},...staff.map(x=>({value:x.id,label:x.name}))]}/></label>
    <label>대상 종류<Select<Scope> aria-label="수당 대상 종류" value={form.scope} onChange={scope=>setForm(initial(scope))} options={[{value:'service',label:'시술'},{value:'product',label:'상품'},{value:'membership',label:'회원권'}]}/></label>
    <label>적용 대상<Select aria-label="수당 적용 대상" value={form.scope==='service'?form.service_id:form.product_id} onChange={id=>setForm(x=>x.scope==='service'?({...x,service_id:id}):({...x,product_id:id}))} options={[{value:'',label:'선택하세요'},...targetOptions.map(x=>({value:x.id,label:x.name}))]}/></label>
    <label>수당률 (%)<input aria-label="수당률" inputMode="decimal" placeholder="예: 15" value={form.rate} onChange={e=>{const value=e.currentTarget.value;setForm(x=>({...x,rate:value}));}}/></label>
    <label>시작일<input type="date" aria-label="수당 시작일" value={form.effective_from} onChange={e=>{const value=e.currentTarget.value;setForm(x=>({...x,effective_from:value}));}}/></label>
    <label>종료일 (선택)<input type="date" aria-label="수당 종료일" value={form.effective_to} onChange={e=>{const value=e.currentTarget.value;setForm(x=>({...x,effective_to:value}));}}/></label>
    <button type="button" disabled={busy} onClick={()=>void save()}>규칙 저장</button>
   </div>
   <div className="inline-form"><label>선택 규칙 종료일<input type="date" aria-label="규칙 종료일" value={endDate} onChange={e=>setEndDate(e.currentTarget.value)}/></label><button type="button" disabled={busy||!selectedRule} onClick={()=>void end()}>선택 규칙 종료</button><button type="button" disabled={busy} onClick={()=>void load()}>새로고침</button></div>
  </>}
  {error&&<p role="alert" className="form-error">{error}</p>}
 </Modal>;
}
