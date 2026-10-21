import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(), otherOrg=randomUUID(), owner=randomUUID(), admin=randomUUID(), member=randomUUID(), outsider=randomUUID();
const customer=randomUUID(), draft=randomUUID();
const q=(sql,params=[])=>db.query(sql,params), one=async(sql,params=[])=>(await q(sql,params)).rows[0];
const fails=(fn,code)=>assert.rejects(fn,error=>{assert.equal(error.code,code,error.message);return true;});
const user=async(id=owner)=>{await db.exec('reset role; set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const get=async(visit)=> (await one('select get_visit_payments($1,$2) data',[org,visit])).data;
const record=async(visit,version,payments,operation=randomUUID(),confirmed=true)=>(await one('select record_visit_payment($1,$2,$3,$4,$5::jsonb,$6) data',[org,visit,version,operation,JSON.stringify(payments),confirmed])).data;
const payment=(method,amount,reference='')=>({method,amount,reference});
let checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log(`PASS ${name}`);};

try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
 grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table memberships(organization_id uuid,user_id uuid,role text);
 create table customers(id uuid primary key,organization_id uuid not null,name text);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create table treatment_sale_drafts(id uuid primary key,organization_id uuid not null,customer_id uuid not null,description text not null,amount numeric(14,2) not null,source_snapshot jsonb not null);
 create table finance_transactions(id uuid primary key default gen_random_uuid(),organization_id uuid not null,transaction_type text not null,amount numeric(14,2) not null,transaction_date date not null,category text not null,counterparty text not null default '',memo text not null default '',is_archived boolean not null default false,created_by uuid not null,created_at timestamptz default now(),updated_at timestamptz default now());
 grant select,insert,update,delete on finance_transactions to authenticated;`);
 await q('insert into auth.users values($1),($2),($3),($4)',[owner,admin,member,outsider]);
 await q('insert into organizations values($1),($2)',[org,otherOrg]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[org,owner,admin,member,otherOrg,outsider]);
 await q("insert into customers values($1,$2,'고객')",[customer,org]);
 await q("insert into treatment_sale_drafts values($1,$2,$3,'시술',100000,$4::jsonb)",[draft,org,customer,JSON.stringify({customer:{name:'고객'}})]);
 await db.exec(await readFile(new URL('../../migrations/024_visit_sale_carts.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../migrations/025_visit_payments.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../migrations/026_sale_cart_hardening_upgrade.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../migrations/026_sale_cart_hardening_upgrade.sql',import.meta.url),'utf8'));
 await user();

 await db.exec('reset role');
 const migration=await readFile(new URL('../../migrations/027_catalog_sales.sql',import.meta.url),'utf8');
 await db.exec(migration);await user();
 const stockMigration=await readFile(new URL('../../migrations/030_inventory_stock_controls.sql',import.meta.url),'utf8');
 await db.exec('reset role');await db.exec(stockMigration);await user();
 const save=async(values,id=null,version=null,op=randomUUID())=>(await one('select save_catalog_product($1,$2,$3,$4,$5::jsonb) data',[org,id,version,op,JSON.stringify(values)])).data;
 const stock=async(id,qty,op=randomUUID())=>(await one('select receive_catalog_stock($1,$2,$3,$4,$5) data',[org,id,qty,'입고',op])).data;
 const changeStock=async(id,kind,qty,reason,version,op=randomUUID())=>(await one('select change_catalog_stock($1,$2,$3,$4,$5,$6,$7) data',[org,id,kind,qty,reason,version,op])).data;
 const fresh=async()=>(await one('select create_customer_visit($1,$2,$3) data',[org,customer,randomUUID()])).data;
 const add=async(c,id,op=randomUUID())=>(await one('select add_catalog_product_to_cart($1,$2,$3,$4,$5) data',[org,c.visit.id,id,c.cart.version,op])).data;
 const ready=async(c)=>(await one('select review_sale_cart($1,$2,$3,$4,true) data',[org,c.visit.id,c.cart.version,randomUUID()])).data;
 const wallets=async()=>(await one('select list_customer_wallets($1,$2) data',[org,customer])).data;
 let prod,mem;
 await check('catalog validation, idempotency and immutable kind',async()=>{
  const op=randomUUID(),v={sku:'P',name:'상품',kind:'product',sale_price:'100'};
  prod=await save(v,null,null,op); assert.deepEqual(await save(v,null,null,op),prod);
  await fails(()=>save({...v,name:'changed'},null,null,op),'P0001');
  await fails(()=>save({sale_price:'1.5'},prod.id,prod.version),'22023');
  await fails(()=>save({sale_price:'0'},prod.id,prod.version),'22023');
  await fails(()=>save({sale_price:100},prod.id,prod.version),'22023');
  await fails(()=>save({name:null},prod.id,prod.version),'22023');
  await fails(()=>save({unit_name:'x'.repeat(31)},prod.id,prod.version),'22023');
  await fails(()=>save({benefit_count:1000000},prod.id,prod.version),'22023');
  await fails(()=>save({kind:'membership',benefit_count:1},prod.id,prod.version),'22023');
  await fails(()=>save({name:'stale'},prod.id,99),'P0001');
  mem=await save({sku:'M',name:'회원권',kind:'membership',sale_price:'200',benefit_money:'300',benefit_count:2,valid_days:1});
 });
 await check('authorization, direct writes and organization boundaries',async()=>{
  await user(member);assert.equal((await one('select list_catalog_products($1) data',[org])).data.length,2);
  assert.deepEqual((await one('select list_catalog_stock_ledger($1,$2) data',[org,prod.id])).data,[]);
  await fails(()=>save({name:'bad'},prod.id,prod.version),'42501');await fails(()=>stock(prod.id,1),'42501');
  await fails(()=>changeStock(prod.id,'disposal',1,'member denied',1),'42501');
  await fails(()=>q('update catalog_products set stock_quantity=10'),'42501');
  await fails(()=>q('insert into customer_wallets default values'),'42501');
  await user(outsider);assert.equal((await q('select * from catalog_products')).rows.length,0);
  await fails(()=>one('select list_catalog_products($1)',[org]),'42501');
  await fails(()=>one('select list_catalog_stock_ledger($1,$2)',[org,prod.id]),'42501');
  await user();await fails(()=>one('select list_customer_wallets($1,$2)',[otherOrg,customer]),'42501');
  await fails(()=>stock(randomUUID(),1),'P0002');
  await fails(()=>one('select change_catalog_stock($1,$2,$3,$4,$5,$6,$7)',[otherOrg,prod.id,'disposal',1,'outside denied',1,randomUUID()]),'42501');
 });
 await check('receipt replay and immutable stock ledger',async()=>{
  const op=randomUUID(); const s=await stock(prod.id,1,op);assert.deepEqual(await stock(prod.id,1,op),s);
  await fails(()=>stock(prod.id,2,op),'P0001');await fails(()=>stock(mem.id,1),'22023');
  await db.exec('reset role');await fails(()=>q('update catalog_stock_ledger set quantity=2'),'P0001');await user();
 });
 await check('partial supplier return, disposal and stocktake are atomic and idempotent',async()=>{
  const testProduct=await save({sku:'STOCK-CTRL',name:'재고 테스트',kind:'product',sale_price:'100'});
  let p=await stock(testProduct.id,10);assert.equal(p.stock_quantity,10);
  const op=randomUUID(),returned=await changeStock(testProduct.id,'supplier_return',3,'일부 거래처 반품',p.version,op);
  assert.equal(returned.stock_quantity,7);assert.deepEqual(await changeStock(testProduct.id,'supplier_return',3,'일부 거래처 반품',p.version,op),returned);
  await fails(()=>changeStock(testProduct.id,'supplier_return',4,'다른 요청',p.version,op),'P0001');
  await fails(()=>changeStock(testProduct.id,'disposal',8,'재고 부족',returned.version),'22023');
  const disposed=await changeStock(testProduct.id,'disposal',2,'파손 폐기',returned.version);assert.equal(disposed.stock_quantity,5);
  assert.equal((await changeStock(testProduct.id,'supplier_return',3,'일부 거래처 반품',p.version,op)).stock_quantity,5);
  const counted=await changeStock(testProduct.id,'stocktake',8,'실사 차이',disposed.version);assert.equal(counted.stock_quantity,8);
  await fails(()=>changeStock(testProduct.id,'stocktake',9,'오래된 실사',disposed.version),'P0001');
  const before=(await one('select count(*)::int n from catalog_stock_ledger where product_id=$1',[testProduct.id])).n;
  const noChange=await changeStock(testProduct.id,'stocktake',8,'차이 없음',counted.version);assert.equal(noChange.version,counted.version);
  assert.equal((await one('select count(*)::int n from catalog_stock_ledger where product_id=$1',[testProduct.id])).n,before);
  assert.deepEqual((await q('select movement_kind,quantity from catalog_stock_ledger where product_id=$1 order by created_at,id',[testProduct.id])).rows.slice(-3),[
   {movement_kind:'supplier_return',quantity:-3},{movement_kind:'disposal',quantity:-2},{movement_kind:'stocktake',quantity:3}
  ]);
  await db.exec('reset role');await fails(()=>q('delete from catalog_stock_ledger where operation_id=$1',[op]),'P0001');await user();
 });
 await check('same product in multiple carts, partial rejection, shortage rolls back finance and receipts',async()=>{
  let a=await ready(await add(await fresh(),prod.id));let b=await ready(await add(await fresh(),prod.id));
  await fails(()=>record(a.visit.id,a.cart.version,[payment('cash','50')]),'22023');
  assert.equal((await get(a.visit.id)).receipts.length,0);
  const op=randomUUID();const paid=await record(a.visit.id,a.cart.version,[payment('cash','100')],op);
  assert.deepEqual(await record(a.visit.id,a.cart.version,[payment('cash','100')],op),paid);
  const before=(await one('select count(*)::int n from finance_transactions')).n;
  await fails(()=>record(b.visit.id,b.cart.version,[payment('cash','100')]),'P0001');
  assert.equal((await get(b.visit.id)).receipts.length,0);assert.equal((await one('select count(*)::int n from finance_transactions')).n,before);
  assert.equal((await one('select stock_quantity from catalog_products where id=$1',[prod.id])).stock_quantity,0);
  await stock(prod.id,1);assert.equal((await record(b.visit.id,b.cart.version,[payment('cash','100')])).status,'paid');
 });
 await check('membership uses stored benefits, quantity and inclusive Seoul expiry only at full payment',async()=>{
  let c=await add(await fresh(),mem.id);
  c=(await one('select mutate_sale_cart_line($1,$2,$3,$4,$5,$6,$7::jsonb) data',[org,c.visit.id,c.lines[0].id,c.cart.version,randomUUID(),'update',JSON.stringify({quantity:2})])).data;
  await save({benefit_money:'999',benefit_count:9,sale_price:'999',valid_days:365},mem.id,mem.version);
  c=await ready(c);let partial=await record(c.visit.id,c.cart.version,[payment('cash','200')]);assert.equal((await wallets()).length,0);
  const op=randomUUID(),paid=await record(c.visit.id,partial.cart_version,[payment('cash','200')],op);
  assert.deepEqual(await record(c.visit.id,partial.cart_version,[payment('cash','200')],op),paid);
  const w=(await wallets())[0];assert.equal(w.money_balance,'600');assert.equal(w.count_balance,4);assert.equal(w.expires_on,w.valid_from);
  assert.equal(w.source_snapshot.sale_price,'200');assert.equal((await one('select count(*)::int n from wallet_issuance_ledger')).n,1);
  await db.exec('reset role');await fails(()=>q('delete from wallet_issuance_ledger'),'P0001');
  await db.exec(migration);await user();assert.deepEqual((await wallets())[0],w);assert.deepEqual(await get(c.visit.id),paid);
 });
 await check('stopped products, duplicate active rows and restore retain uniqueness',async()=>{
  let p= (await one('select list_catalog_products($1) data',[org])).data.find(p=>p.id===prod.id);
  p=await save({is_active:false},p.id,p.version);let c=await fresh();await fails(()=>add(c,p.id),'P0001');
  p=await save({is_active:true},p.id,p.version);c=await add(c,p.id);await fails(()=>add(c,p.id),'P0001');
  const removed=(await one('select mutate_sale_cart_line($1,$2,$3,$4,$5,$6,$7::jsonb) data',[org,c.visit.id,c.lines[0].id,c.cart.version,randomUUID(),'remove',JSON.stringify({reason:'취소'})])).data;
  const added=await add(removed,p.id);await fails(()=>one('select mutate_sale_cart_line($1,$2,$3,$4,$5,$6,$7::jsonb)',[org,c.visit.id,c.lines[0].id,added.cart.version,randomUUID(),'restore','{}']),'P0001');
 });
 await check('multiple product shortage is atomic after earlier sorted product deduction',async()=>{
  const p2=await save({sku:'P2',name:'둘',kind:'product',sale_price:'10'});
  const sorted=[prod.id,p2.id].sort();await stock(sorted[0],1);
  let c=await fresh();c=await add(c,sorted[1]);c=await add(c,sorted[0]);c=await ready(c);
  const before=(await one('select count(*)::int n from catalog_stock_ledger')).n;
  await fails(()=>record(c.visit.id,c.cart.version,[payment('cash','110')]),'P0001');
  assert.equal((await one('select stock_quantity from catalog_products where id=$1',[sorted[0]])).stock_quantity,1);
  assert.equal((await one('select count(*)::int n from catalog_stock_ledger')).n,before);
  assert.equal((await get(c.visit.id)).receipts.length,0);
 });
 await check('stock migration is safe to reapply',async()=>{
  await db.exec('reset role');await db.exec(stockMigration);await user();
  const p=(await one('select list_catalog_products($1) data',[org])).data.find(x=>x.sku==='STOCK-CTRL');
  assert.equal(p.stock_quantity,8);
 });
 await db.exec('reset role');
 for(const name of ['058_purchase_orders.sql','066_inventory_lots_fefo.sql','067_catalog_category_barcode.sql','068_inventory_cost_basis.sql']) await db.exec(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../migrations/036_management_preview.sql',import.meta.url),'utf8'));
 const costReportMigration=await readFile(new URL('../../migrations/070_management_cost_basis.sql',import.meta.url),'utf8');await db.exec(costReportMigration);await db.exec(costReportMigration);
 await db.exec('reset role');
 const costed=(await one('select save_catalog_product($1,null,null,$2,$3::jsonb) data',[org,randomUUID(),JSON.stringify({sku:'COST-BASIS',name:'원가 상품',kind:'product',unit_name:'개',sale_price:'5000',benefit_money:'0',benefit_count:0,valid_days:null,is_active:true})])).data;
 await one('select receive_catalog_stock($1,$2,3,$3,$4,null,$5,1200)',[org,costed.id,'원가 검증 입고',randomUUID(),'KNOWN-COST']);
 await q('update catalog_products set stock_quantity=stock_quantity-2 where organization_id=$1 and id=$2',[org,costed.id]);
 await q("insert into catalog_stock_ledger(organization_id,product_id,quantity,reason,operation_id,created_by,movement_kind) values($1,$2,-2,'원가 검증 시술 소모',$3,$4,'treatment_use')",[org,costed.id,randomUUID(),owner]);
 await user();
 await check('management preview distinguishes recorded net and unallocated staff basis',async()=>{
  const report=(await one('select get_management_preview($1,$2,$3) data',
   [org,'2026-10-01','2026-10-31'])).data;
  assert.equal(report.organization_id,org);
  assert.equal(report.is_final_profit,false);
  assert.equal(report.staff_basis_is_commission,false);
  assert.equal(report.inventory_cogs,'2400');
  assert.ok(report.inventory_cost_unknown_units>=0);
  assert.ok(report.operating_profit_before_commission_tax===null||typeof report.operating_profit_before_commission_tax==='string');
  assert.ok(report.staff_sales_basis.length>=1);
  assert.ok(Number(report.recorded_income)>0);
  await user(member);
  await fails(()=>one('select get_management_preview($1,$2,$3)',[org,'2026-10-01','2026-10-31']),'42501');
  await user(outsider);
  await fails(()=>one('select get_management_preview($1,$2,$3)',[org,'2026-10-01','2026-10-31']),'42501');
  await user();
  await fails(()=>one('select get_management_preview($1,$2,$3)',[otherOrg,'2026-10-01','2026-10-31']),'42501');
  await fails(()=>one('select get_management_preview($1,$2,$3)',[org,'2026-11-01','2026-10-01']),'22023');
 });
 console.log(checks+' catalog sale checks passed');
}finally{await db.close();}
