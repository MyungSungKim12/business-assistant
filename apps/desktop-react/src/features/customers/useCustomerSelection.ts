import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { Customer } from '../../api/schemas';
import { searchCustomers } from './customerSearch';

/** Bounded server selection. Invalidating a generation cancels delivery even on native transports without AbortSignal. */
export function useCustomerSelection(api: ApiClient, organizationId: string, value: string | null, includeArchived = false) {
  const [query, setQueryState] = useState('');
  const [page, setPage] = useState<Customer[]>([]);
  const [selectedState, setSelected] = useState<{org:string; row:Customer} | null>(null);
  const [status, setStatus] = useState<'loading'|'ready'|'error'>('loading');
  const [selectionError,setSelectionError]=useState(false);
  const [cursor,setCursor]=useState<string|null>(null);
  const [total,setTotal]=useState(0);
  const [revision,setRevision]=useState(0);
  const generation=useRef(0);
  const scope=useRef(organizationId);
  const selected=selectedState?.org===organizationId&&selectedState.row.id===value?selectedState.row:undefined;
  const setQuery=useCallback((next:string)=>{generation.current++;setPage([]);setCursor(null);setStatus('loading');setQueryState(next);},[]);
  useEffect(()=>{
    let alive=true;
    setSelectionError(false);
    if(!value){setSelected(null);return;}
    void api.getCustomer(organizationId,value).then(row=>{if(alive){if(row.organization_id!==organizationId||row.id!==value)throw Error('Customer mismatch');setSelected({org:organizationId,row});}}).catch(()=>{if(alive)setSelectionError(true);});
    return()=>{alive=false;};
  },[api,organizationId,value,revision]);
  const load=useCallback(async(ticket:number,next:string|null)=>{
    setStatus('loading');
    try{
      const result=await searchCustomers(api,organizationId,{exclude_archived:!includeArchived,q:query,status:'all',sort:'name',limit:50,cursor:next});
      if(ticket!==generation.current)return;
      if(result.items.some(row=>row.organization_id!==organizationId))throw Error('Customer mismatch');
      const items=result.items.filter(row=>includeArchived||row.status!=='archived');
      setPage(old=>next?[...new Map([...old,...items].map(row=>[row.id,row])).values()]:items);
      setCursor(result.next_cursor);setTotal(result.total);setStatus('ready');
    }catch{if(ticket===generation.current)setStatus('error');}
  },[api,organizationId,query,includeArchived]);
  useEffect(()=>{
    const ticket=++generation.current;
    if(scope.current!==organizationId){scope.current=organizationId;setPage([]);setSelected(null);}
    setStatus('loading');setCursor(null);
    const timer=setTimeout(()=>{void load(ticket,null);},query.trim()?250:0);
    return()=>{generation.current++;clearTimeout(timer);};
  },[load,revision,organizationId,query]);
  const rows=useMemo(()=>{const found=new Map(page.filter(row=>row.organization_id===organizationId).map(row=>[row.id,row]));if(selected)found.set(selected.id,selected);return selected?[selected,...[...found.values()].filter(row=>row.id!==selected.id)]:[...found.values()];},[page,selected,organizationId]);
  return {query,setQuery,rows,page,selected,status,selectionError,total,cursor,retry:()=>setRevision(n=>n+1),more:()=>{if(cursor&&status!=='loading')void load(++generation.current,cursor);},remember:(row:Customer)=>setSelected({org:organizationId,row})};
}
