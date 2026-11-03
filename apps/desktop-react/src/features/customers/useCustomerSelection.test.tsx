import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import { useCustomerSelection } from './useCustomerSelection';
const row=(id:string)=>({id,name:id,status:'active',organization_id:'org',phone:null,tags:[]});
it('debounces server search, ignores obsolete responses and retains selected ID outside results',async()=>{
 let finish:(value:unknown)=>void=()=>{};
 const call=vi.fn(async(_m:string,path:string)=>path.includes('q=old')?new Promise(resolve=>{finish=resolve;}):({items:[row(path.includes('q=new')?'new':'first')],total:1501,next_cursor:'next'}));
 const api={call,getCustomer:vi.fn(async()=>row('selected')),listCustomers:vi.fn()} as unknown as ApiClient;
 const {result}=renderHook(()=>useCustomerSelection(api,'org','selected'));
 await waitFor(()=>expect(result.current.status).toBe('ready'));
 expect(result.current.rows.map(r=>r.id)).toEqual(['selected','first']);
 act(()=>result.current.setQuery('old'));
 await waitFor(()=>expect(call.mock.calls.some(c=>c[1].includes('q=old'))).toBe(true));
 act(()=>result.current.setQuery('new'));
 await waitFor(()=>expect(result.current.rows.some(r=>r.id==='new')).toBe(true));
 await act(async()=>{finish({items:[row('obsolete')],total:1,next_cursor:null});});
 expect(result.current.rows.map(r=>r.id)).toEqual(['selected','new']);
 expect(api.listCustomers).not.toHaveBeenCalled();
});
it('search failure preserves current customer and can retry without changing selection',async()=>{
 let fails=false;
 const api={call:vi.fn(async()=>{if(fails)throw Error('offline');return {items:[row('first')],total:1,next_cursor:null};}),getCustomer:vi.fn(async()=>row('selected'))} as unknown as ApiClient;
 const {result}=renderHook(()=>useCustomerSelection(api,'org','selected'));
 await waitFor(()=>expect(result.current.status).toBe('ready'));
 fails=true;act(()=>result.current.setQuery('fail'));
 await waitFor(()=>expect(result.current.status).toBe('error'));
 expect(result.current.rows.map(r=>r.id)).toContain('selected');
 fails=false;act(()=>result.current.retry());
 await waitFor(()=>expect(result.current.status).toBe('ready'));
 expect(result.current.selected?.id).toBe('selected');
});
it('continues bounded pages and clears organization-scoped rows on organization change',async()=>{
 const paths:string[]=[];
 const api={call:vi.fn(async(_m:string,path:string)=>{paths.push(path);const org=path.includes('/other/')?'other':'org';return {items:[{...row(path.includes('cursor=next')?'second':'first'),organization_id:org}],total:2,next_cursor:path.includes('cursor=next')?null:'next'};}),getCustomer:vi.fn()} as unknown as ApiClient;
 const {result,rerender}=renderHook(({org})=>useCustomerSelection(api,org,null),{initialProps:{org:'org'}});
 await waitFor(()=>expect(result.current.status).toBe('ready'));
 act(()=>result.current.more());
 await waitFor(()=>expect(result.current.rows.map(r=>r.id)).toEqual(['first','second']));
 expect(paths.every(path=>path.includes('limit=50'))).toBe(true);
 rerender({org:'other'});
 await waitFor(()=>expect(result.current.status).toBe('ready'));
 expect(result.current.rows).toHaveLength(1);
 expect(result.current.rows[0].organization_id).toBe('other');
});

it('excludes archives before the first page/count and includes other live statuses',async()=>{
 const archived=Array.from({length:50},(_,i)=>({...row('archive-'+i),status:'archived'}));
 const live={...row('vip'),status:'vip'};
 const api={call:vi.fn(async(_m:string,path:string)=>{const params=new URLSearchParams(path.split('?')[1]);const rows=params.get('exclude_archived')==='true'?[live]:[...archived,live];return {items:rows.slice(0,50),total:rows.length,next_cursor:null};}),getCustomer:vi.fn()} as unknown as ApiClient;
 const {result,rerender}=renderHook(({include})=>useCustomerSelection(api,'org',null,include),{initialProps:{include:false}});
 await waitFor(()=>expect(result.current.status).toBe('ready'));
 expect(result.current.page.map(r=>r.id)).toEqual(['vip']);expect(result.current.total).toBe(1);
 rerender({include:true});
 await waitFor(()=>expect(result.current.total).toBe(51));expect(result.current.page).toHaveLength(50);
});

it('ignores stale selected-ID responses after a focused customer change',async()=>{
 let finish:(value:unknown)=>void=()=>{};
 const api={call:vi.fn(async()=>({items:[],total:0,next_cursor:null})),getCustomer:vi.fn(async(_org:string,id:string)=>id==='old'?new Promise(resolve=>{finish=resolve;}):row(id))} as unknown as ApiClient;
 const {result,rerender}=renderHook(({id})=>useCustomerSelection(api,'org',id),{initialProps:{id:'old'}});
 await waitFor(()=>expect(api.getCustomer).toHaveBeenCalledWith('org','old'));
 rerender({id:'focused'});
 await waitFor(()=>expect(result.current.selected?.id).toBe('focused'));
 await act(async()=>{finish(row('old'));});
 expect(result.current.rows.map(r=>r.id)).toEqual(['focused']);
});
