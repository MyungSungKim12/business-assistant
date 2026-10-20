import { describe, expect, it, vi } from 'vitest';
import { createCatalogGateway } from './catalog/gateway.js';
import { createDocumentGateway } from './documents/gateway.js';
import { testConfig as config, ORG, OTHER_ORG } from './catalog/testkit.js';
import { fileRow, USER } from './documents/testkit.js';

const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const supplier={id:id(1),organization_id:ORG,name:'공급처',contact_name:'',phone:'',email:'',note:'',is_active:true,version:1,created_by:USER,created_at:'2026-10-01T01:00:00Z',updated_at:'2026-10-01T01:00:00Z'};
const order={id:id(2),organization_id:ORG,supplier_id:supplier.id,status:'ordered',ordered_at:'2026-10-01T01:00:00Z',note:'',version:1,created_by:USER,created_at:'2026-10-01T01:00:00Z',updated_at:'2026-10-01T01:00:00Z'};
const line={id:id(3),organization_id:ORG,order_id:order.id,product_id:id(4),quantity_ordered:3,quantity_received:0,unit_cost:'1200',note:'',created_at:'2026-10-01T01:00:00Z'};
const folder={id:id(5),organization_id:ORG,name:'사진',created_by:USER,created_at:'2026-10-01T01:00:00Z'};
type Rows=Record<string,Array<Record<string,unknown>>>;

function paged(rows:Rows,options:{failTable?:string;foreignTable?:string;pageSize?:number}={}){
 const calls:URL[]=[];
 const fetcher=vi.fn(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=new URL(String(input)),table=url.pathname.split('/').at(-1)!;
  calls.push(url);
  expect(url.searchParams.get('organization_id')).toBe(`eq.${ORG}`);
  expect(init?.headers).toMatchObject({Authorization:'Bearer token',Prefer:'count=exact'});
  const offset=Number(url.searchParams.get('offset'));
  if(options.failTable===table&&offset>0)return new Response('{}',{status:503});
  const all=rows[table]??[],batch=all.slice(offset,offset+(options.pageSize??1)).map(row=>options.foreignTable===table&&offset>0?{...row,organization_id:OTHER_ORG}:row);
  return new Response(JSON.stringify(batch),{headers:{'Content-Range':all.length?`${offset}-${offset+batch.length-1}/${all.length}`:'*/0'}});
 });
 return {fetcher,calls};
}

describe('large list gateway integration',()=>{
 it('1,000행을 넘는 파일과 발주 품목도 마지막 행까지 누락 없이 읽는다',async()=>{
  const manyFiles=Array.from({length:1201},(_,n)=>({...fileRow,id:id(1000+n)}));
  const manyLines=Array.from({length:1203},(_,n)=>({...line,id:id(3000+n)}));
  const {fetcher}=paged({file_assets:manyFiles,catalog_purchase_orders:[order],catalog_purchase_order_lines:manyLines},{pageSize:137});
  const files=await createDocumentGateway(config,fetcher).listFiles('token',ORG,false);
  const orders=await createCatalogGateway(config,fetcher).listPurchaseOrders('token',ORG);
  expect(files).toHaveLength(1201);expect(files.at(-1)?.id).toBe(manyFiles.at(-1)?.id);
  expect(orders[0].lines).toHaveLength(1203);expect(orders[0].lines.at(-1)?.id).toBe(manyLines.at(-1)?.id);
 });
 it('발주서·품목·공급처의 서로 다른 페이지 경계를 끝까지 조회하고 결합한다',async()=>{
  const second={...order,id:id(6)};
  const {fetcher,calls}=paged({catalog_suppliers:[supplier,{...supplier,id:id(7)}],catalog_purchase_orders:[order,second],catalog_purchase_order_lines:[line,{...line,id:id(8)},{...line,id:id(9),order_id:second.id}]});
  const gateway=createCatalogGateway(config,fetcher);
  const result=await gateway.listPurchaseOrders('token',ORG);
  expect(result.map(o=>o.lines.length)).toEqual([2,1]);
  expect(await gateway.listSuppliers('token',ORG)).toHaveLength(2);
  expect(calls).toHaveLength(7);
 });
 it.each(['catalog_purchase_orders','catalog_purchase_order_lines'])('발주 %s 중간 실패와 후속 페이지 조직 혼입을 거절한다',async(table)=>{
  const rows={catalog_purchase_orders:[order,{...order,id:id(6)}],catalog_purchase_order_lines:[line,{...line,id:id(8)}]};
  for(const options of [{failTable:table},{foreignTable:table}]){
   await expect(createCatalogGateway(config,paged(rows,options).fetcher).listPurchaseOrders('token',ORG)).rejects.toMatchObject({status:503});
  }
 });
 it('부모 발주서 없는 품목을 조용히 버리지 않는다',async()=>{
  const {fetcher}=paged({catalog_purchase_orders:[order],catalog_purchase_order_lines:[{...line,order_id:id(100)}]});
  await expect(createCatalogGateway(config,fetcher).listPurchaseOrders('token',ORG)).rejects.toMatchObject({status:503});
 });
 it('파일·폴더를 페이지별로 조회하고 보관 필터와 내부 경로 비노출을 유지한다',async()=>{
  const {fetcher,calls}=paged({file_assets:[fileRow,{...fileRow,id:id(10)}],file_folders:[folder,{...folder,id:id(11)}]});
  const gateway=createDocumentGateway(config,fetcher);
  const files=await gateway.listFiles('token',ORG,false);
  expect(files).toHaveLength(2);expect(files[1]).not.toHaveProperty('storage_path');
  expect(calls.every(url=>url.searchParams.get('is_archived')==='eq.false')).toBe(true);
  expect(await gateway.listFileFolders('token',ORG)).toHaveLength(2);
  calls.length=0;
  await gateway.listFiles('token',ORG,true);
  expect(calls.every(url=>!url.searchParams.has('is_archived'))).toBe(true);
 });
 it.each(['file_assets','file_folders'])('%s 후속 페이지 실패·조직 혼입을 거절한다',async(table)=>{
  const rows={file_assets:[fileRow,{...fileRow,id:id(10)}],file_folders:[folder,{...folder,id:id(11)}]};
  for(const options of [{failTable:table},{foreignTable:table}]){
   const gateway=createDocumentGateway(config,paged(rows,options).fetcher);
   await expect(table==='file_assets'?gateway.listFiles('token',ORG,false):gateway.listFileFolders('token',ORG)).rejects.toMatchObject({status:503});
  }
 });
});
