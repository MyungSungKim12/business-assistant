import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(),otherOrg=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID();
const customer=randomUUID(),otherCustomer=randomUUID();
const q=(sql,params=[])=>db.query(sql,params),one=async(sql,params=[])=>(await q(sql,params)).rows[0];
const fails=(fn,code)=>assert.rejects(fn,error=>{assert.equal(error.code,code,error.message);return true;});
const user=async(id=owner)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const payment=(method,amount,reference='')=>({method,amount,reference});
let checks=0;const check=async(name,fn)=>{await fn();checks++;console.log(`PASS ${name}`);};

try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
 grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table memberships(organization_id uuid,user_id uuid,role text);
 create table customers(id uuid primary key,organization_id uuid not null,name text,status text not null default 'active',unique(organization_id,id));
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create table treatment_sale_drafts(id uuid primary key,organization_id uuid not null,customer_id uuid not null,description text not null,amount numeric(14,2) not null,source_snapshot jsonb not null);
 create table finance_transactions(id uuid primary key default gen_random_uuid(),organization_id uuid not null,transaction_type text not null,amount numeric(14,2) not null,transaction_date date not null,category text not null,counterparty text not null default '',memo text not null default '',is_archived boolean not null default false,created_by uuid not null,created_at timestamptz default now(),updated_at timestamptz default now());
 grant select,insert,update,delete on finance_transactions to authenticated;`);
 await q('insert into auth.users values($1),($2),($3)',[owner,member,outsider]);
 await q('insert into organizations values($1),($2)',[org,otherOrg]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[org,owner,member,otherOrg,outsider]);
 await q("insert into customers values($1,$2,'고객'),($3,$2,'다른 고객')",[customer,org,otherCustomer]);
 for(const name of ['024_visit_sale_carts.sql','025_visit_payments.sql','026_sale_cart_hardening_upgrade.sql','027_catalog_sales.sql','028_wallet_usage.sql','029_payment_refunds.sql'])
  await db.exec(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
 await user();
 const fresh=async(customerId=customer)=>(await one('select create_customer_visit($1,$2,$3) data',[org,customerId,randomUUID()])).data;
 const ready=async(c)=>(await one('select review_sale_cart($1,$2,$3,$4,true) data',[org,c.visit.id,c.cart.version,randomUUID()])).data;
 const record=async(c,amount)=>(await one('select record_visit_payment($1,$2,$3,$4,$5::jsonb,true) data',[org,c.visit.id,c.cart.version,randomUUID(),JSON.stringify([payment('cash',amount)])])).data;
 const save=async(values)=>(await one('select save_catalog_product($1,null,null,$2,$3::jsonb) data',[org,randomUUID(),JSON.stringify(values)])).data;
 const addCatalog=async(c,id)=>(await one('select add_catalog_product_to_cart($1,$2,$3,$4,$5) data',[org,c.visit.id,id,c.cart.version,randomUUID()])).data;
 const wallets=async(customerId=customer)=>(await one('select list_customer_wallets($1,$2) data',[org,customerId])).data;
 const treatmentCart=async(amount='100')=>{
  const draft=randomUUID();await db.exec('reset role');await q("insert into treatment_sale_drafts values($1,$2,$3,'시술',$4,'{}'::jsonb)",[draft,org,customer,amount]);await user();
  let c=await fresh();c=(await one('select add_treatment_draft_to_cart($1,$2,$3,$4,$5) data',[org,c.visit.id,draft,c.cart.version,randomUUID()])).data;return ready(c);
 };
 const use=async(c,wallet,line,mode,amount=null,op=randomUUID())=>(await one('select use_customer_wallet($1,$2,$3,$4,$5,$6,$7,$8,true) data',[org,c.visit.id,wallet,line,mode,amount,c.cart.version,op])).data;

 const membership=await save({sku:'W',name:'복합권',kind:'membership',sale_price:'100',benefit_money:'300',benefit_count:2});
 let issue=await addCatalog(await fresh(),membership.id);issue=await ready(issue);await record(issue,'100');
 let wallet=(await wallets())[0];

 await check('money and count usage reconcile the visit and immutable history',async()=>{
  let c=await treatmentCart();const line=c.lines[0];const op=randomUUID();
  const partial=await use(c,wallet.id,line.id,'money','40',op);assert.equal(partial.status,'collecting');assert.equal(partial.paid_amount,40);
  assert.deepEqual(await one('select use_customer_wallet($1,$2,$3,$4,$5,$6,$7,$8,true) data',[org,c.visit.id,wallet.id,line.id,'money','40',c.cart.version,op]).then(x=>x.data),partial);
  await fails(()=>one('select use_customer_wallet($1,$2,$3,$4,$5,$6,$7,$8,true)',[org,c.visit.id,wallet.id,line.id,'money','41',c.cart.version,op]),'P0001');
  c={...c,cart:{...c.cart,version:partial.cart_version}};
  const paid=await use(c,wallet.id,line.id,'count');assert.equal(paid.status,'paid');assert.equal(paid.outstanding_amount,0);
  wallet=(await wallets())[0];assert.equal(wallet.money_balance,'260');assert.equal(wallet.count_balance,1);assert.equal(wallet.usage_history.length,2);
  assert.equal(wallet.usage_history[0].count_delta,-1);assert.equal(paid.receipts.filter(r=>r.method==='wallet').length,2);
  await db.exec('reset role');await fails(()=>q('delete from wallet_usage_ledger'),'P0001');await user();
 });

 await check('wallet usage plus cash cannot exceed and can close the same visit',async()=>{
  let c=await treatmentCart();const line=c.lines[0];let partial=await use(c,wallet.id,line.id,'money','30');
  c={...c,cart:{...c.cart,version:partial.cart_version}};
  await fails(()=>record(c,'71'),'22023');const paid=await record(c,'70');assert.equal(paid.status,'paid');assert.equal(paid.paid_amount,100);
  assert.equal(paid.receipts.find(r=>r.method==='wallet').amount,30);
 });

 await check('last count cannot be consumed twice and balance never becomes negative',async()=>{
  let a=await treatmentCart('50'),b=await treatmentCart('50');
  const first=await use(a,wallet.id,a.lines[0].id,'count');assert.equal(first.status,'paid');
  await fails(()=>use(b,wallet.id,b.lines[0].id,'count'),'P0001');wallet=(await wallets())[0];assert.equal(wallet.count_balance,0);
 });

 await check('role, customer, organization and direct-write boundaries',async()=>{
  const c=await treatmentCart('10');
  await user(member);await fails(()=>use(c,wallet.id,c.lines[0].id,'money','10'),'42501');
  await fails(()=>q("insert into wallet_usage_ledger(id) values(gen_random_uuid())"),'42501');
  await user(outsider);await fails(()=>one('select list_customer_wallets($1,$2)',[org,customer]),'42501');
  await user();const other=await fresh(otherCustomer);await fails(()=>use({...other,cart:{...other.cart,status:'ready'}},wallet.id,randomUUID(),'money','1'),'P0001');
 });

 await check('expired wallet and invalid targets are rejected without a ledger row',async()=>{
  const c=await treatmentCart('10');const before=(await one('select count(*)::int n from wallet_usage_ledger')).n;
  await db.exec('reset role');await q("update customer_wallets set valid_from=current_date-2,expires_on=current_date-1 where id=$1",[wallet.id]);await user();
  await fails(()=>use(c,wallet.id,c.lines[0].id,'money','10'),'P0001');
  assert.equal((await one('select count(*)::int n from wallet_usage_ledger')).n,before);
 });
 await check('migration reapply preserves wallet balances and usage history',async()=>{
  const before=await wallets();await db.exec('reset role');
  await db.exec(await readFile(new URL('../../migrations/028_wallet_usage.sql',import.meta.url),'utf8'));
  await user();assert.deepEqual(await wallets(),before);
 });
 await db.exec('reset role');
 await db.exec(await readFile(new URL('../../migrations/035_wallet_lifecycle.sql',import.meta.url),'utf8'));
 if(process.argv.includes('--transfer')||process.argv.includes('--refund')){const sql=await readFile(new URL('../../migrations/075_wallet_transfer.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);}
 if(process.argv.includes('--refund')){
  await db.exec(`
   create function private.sale_cart_line_discount(uuid,uuid) returns numeric language sql stable as $$select 0::numeric$$;
   create table appointment_staff(id uuid primary key,organization_id uuid not null,auth_user_id uuid,name text,unique(organization_id,id));
   create table staff_commission_rules(id uuid primary key,organization_id uuid not null,commission_scope text not null,staff_id uuid,product_id uuid,service_id uuid,rate_basis_points int not null,effective_from date not null,effective_to date,created_at timestamptz default now());
   create table staff_commission_settlements(id uuid primary key default gen_random_uuid(),organization_id uuid not null,from_date date not null,to_date date not null);
   create function private.staff_commission_preview(uuid,date,date) returns jsonb language sql stable as $$select '[]'::jsonb$$;
  `);
  const refundMigration=await readFile(new URL('../../migrations/087_wallet_partial_refunds.sql',import.meta.url),'utf8');
  await db.exec(refundMigration);await db.exec(refundMigration);
  await db.exec(await readFile(new URL('../../migrations/092_wallet_manual_refunds.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../migrations/092_wallet_manual_refunds.sql',import.meta.url),'utf8'));
  const productRow=await save({sku:'CASH-ONLY',name:'현금 금액권',kind:'membership',sale_price:'100',benefit_money:'100',benefit_count:0});
  let sale=await addCatalog(await fresh(),productRow.id);sale=await ready(sale);await record(sale,'100');
  const cashWallet=(await wallets()).find(row=>row.product_id===productRow.id);
  const preview=await one('select preview_wallet_purchase_refund($1,$2,$3) data',[org,customer,cashWallet.id]);
  assert.equal(preview.data.refund_cap,'100');
  await check('a real-price cash membership exposes its safe refund cap',async()=>{
   assert.equal(preview.data.balance_version,1);assert.equal(preview.data.money_balance,'100');
   await user(member);await fails(()=>one('select preview_wallet_purchase_refund($1,$2,$3)',[org,customer,cashWallet.id]),'42501');await user();
   const mismatched=await save({sku:'CASH-BONUS',name:'보너스 금액권',kind:'membership',sale_price:'100',benefit_money:'110',benefit_count:0});
   let mismatchSale=await addCatalog(await fresh(),mismatched.id);mismatchSale=await ready(mismatchSale);await record(mismatchSale,'100');
   const bonusWallet=(await wallets()).find(row=>row.product_id===mismatched.id);
   await fails(()=>one('select preview_wallet_purchase_refund($1,$2,$3)',[org,customer,bonusWallet.id]),'P0001');
  });
  await check('partial refund reduces wallet and adds finance, history, and negative commission records',async()=>{
   const reason='고객 요청 환불',op=randomUUID(),version=preview.data.balance_version;
   await db.exec(`reset role;create function private.reject_test_wallet_refund() returns trigger language plpgsql as $$begin if new.amount=40 then raise exception 'forced ledger failure' using errcode='P0001';end if;return new;end$$;create trigger reject_test_wallet_refund before insert on wallet_purchase_refund_events for each row execute function private.reject_test_wallet_refund();`);
   await user();const beforeFinance=(await one("select count(*)::int n from finance_transactions where category='Membership refund'")).n;
   await fails(()=>one('select refund_wallet_purchase($1,$2,$3,$4,$5,$6,$7,true)',[org,customer,cashWallet.id,'40','원자성 시험',version,randomUUID()]),'P0001');
   assert.equal((await wallets()).find(row=>row.id===cashWallet.id).money_balance,'100');
   assert.equal((await one("select count(*)::int n from finance_transactions where category='Membership refund'")).n,beforeFinance);
   await db.exec('reset role;drop trigger reject_test_wallet_refund on wallet_purchase_refund_events;drop function private.reject_test_wallet_refund();');await user();
   const args=[org,customer,cashWallet.id,'30',reason,version,op,true];
   const result=(await one('select refund_wallet_purchase($1,$2,$3,$4,$5,$6,$7,$8) data',args)).data;
   assert.equal(result.previous_balance,'100');assert.equal(result.new_balance,'70');assert.equal(result.lifecycle_status,'active');
   assert.deepEqual((await one('select refund_wallet_purchase($1,$2,$3,$4,$5,$6,$7,$8) data',args)).data,result);
   await fails(()=>one('select refund_wallet_purchase($1,$2,$3,$4,$5,$6,$7,true)',[org,customer,cashWallet.id,'29',reason,version,op]),'P0001');
   assert.equal((await wallets()).find(row=>row.id===cashWallet.id).money_balance,'70');
   assert.equal((await one('select amount from finance_transactions where id=$1',[result.finance_transaction_id])).amount,'30.00');
   assert.equal((await one('select list_wallet_history($1,$2,$3) data',[org,customer,cashWallet.id])).data.some(event=>event.event_type==='refund'&&event.money_delta==='-30'),true);
   const event=(await one('select id,amount,finance_transaction_id from wallet_purchase_refund_events where wallet_id=$1',[cashWallet.id]));
   await db.exec('reset role');
   const lines=(await one(`select private.staff_commission_preview($1,current_date,current_date) data`,[org])).data;
   assert.equal(lines.filter(event=>event.event_kind==='refund'&&event.net_paid_amount==='-30').length,1);
   await fails(()=>q("update wallet_purchase_refund_events set reason='변경'"),'P0001');await user();
   await db.exec('reset role');await fails(()=>q('update finance_transactions set amount=99 where id=$1',[event.finance_transaction_id]),'P0001');await user();
   await fails(()=>one('select refund_wallet_purchase($1,$2,$3,$4,$5,$6,$7,$8)',[org,customer,cashWallet.id,'71','초과',2,randomUUID(),true]),'22023');
   await fails(()=>one('select refund_wallet_purchase($1,$2,$3,$4,$5,$6,$7,$8)',[org,customer,cashWallet.id,'1','오래된 버전',1,randomUUID(),true]),'P0001');
   await user(member);await fails(()=>one('select refund_wallet_purchase($1,$2,$3,$4,$5,$6,$7,$8)',[org,customer,cashWallet.id,'1','권한 없음',2,randomUUID(),true]),'42501');await user();
   assert.equal((await one('select amount from wallet_purchase_refund_events where id=$1',[event.id])).amount,'30');
  });
  await check('manual refund migration backfills immutable legacy event rows',async()=>{
   await db.exec('reset role;drop trigger immutable on wallet_purchase_refund_events');
   await q('update wallet_purchase_refund_events set cash_refund_amount=0,money_removed=0 where wallet_id=$1',[cashWallet.id]);
   await db.exec('create trigger immutable before update or delete on wallet_purchase_refund_events for each row execute function private.prevent_catalog_ledger_change()');
   await db.exec(await readFile(new URL('../../migrations/092_wallet_manual_refunds.sql',import.meta.url),'utf8'));
   const legacy=await one('select amount,cash_refund_amount,money_removed,count_removed from wallet_purchase_refund_events where wallet_id=$1',[cashWallet.id]);
   assert.equal(legacy.cash_refund_amount,legacy.amount);assert.equal(legacy.money_removed,legacy.amount);assert.equal(legacy.count_removed,0);await user();
  });
  await check('manual refund records cash and money/count benefit removals independently',async()=>{
   const mixed=await save({sku:'MIXED-MANUAL',name:'복합 회원권',kind:'membership',sale_price:'80',benefit_money:'100',benefit_count:2});
   let sale=await addCatalog(await fresh(),mixed.id);sale=await ready(sale);await record(sale,'80');
   const mixedWallet=(await wallets()).find(row=>row.product_id===mixed.id);
   const preview=(await one('select preview_wallet_purchase_refund_benefits($1,$2,$3) data',[org,customer,mixedWallet.id])).data;
   assert.equal(preview.refund_cap,'80');assert.equal(preview.money_balance,'100');assert.equal(preview.count_balance,2);
   const op=randomUUID(),args=[org,customer,mixedWallet.id,'25','10',1,'수기 환불 정책',preview.balance_version,op,true];
   await user(member);await fails(()=>one('select refund_wallet_purchase_benefits($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',args),'42501');await user();
   const result=(await one('select refund_wallet_purchase_benefits($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) data',args)).data;
   assert.equal(result.amount,'25');assert.equal(result.money_removed,'10');assert.equal(result.count_removed,1);
   assert.equal(result.new_balance,'90');assert.equal(result.new_count_balance,1);
   assert.deepEqual((await one('select refund_wallet_purchase_benefits($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) data',args)).data,result);
   const stored=(await wallets()).find(row=>row.id===mixedWallet.id);assert.equal(stored.money_balance,'90');assert.equal(stored.count_balance,1);
   assert.equal((await one('select amount from finance_transactions where id=$1',[result.finance_transaction_id])).amount,'25.00');
   const history=(await one('select list_wallet_history($1,$2,$3) data',[org,customer,mixedWallet.id])).data;
   assert.equal(history.some(event=>event.event_type==='refund'&&event.money_delta==='-10'&&event.count_delta===-1),true);
   await db.exec('reset role');const commission=(await one('select private.staff_commission_preview($1,current_date,current_date) data',[org])).data;assert.equal(commission.some(event=>event.event_kind==='refund'&&event.net_paid_amount==='-25'),true);await user();
   await fails(()=>one('select refund_wallet_purchase_benefits($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[org,customer,mixedWallet.id,'56','0',0,'초과 환불',result.balance_version,randomUUID(),true]),'22023');
   await fails(()=>one('select refund_wallet_purchase_benefits($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[org,customer,mixedWallet.id,'1','0',2,'초과 횟수',result.balance_version,randomUUID(),true]),'22023');
  });
  await check('full refund closes the wallet and settled periods block dated adjustments',async()=>{
   const cashWallet=(await wallets()).find(row=>row.product_id===productRow.id);
   const cap=(await one('select preview_wallet_purchase_refund($1,$2,$3) data',[org,customer,cashWallet.id])).data;
   const closed=(await one('select refund_wallet_purchase($1,$2,$3,$4,$5,$6,$7,true) data',[org,customer,cashWallet.id,'70','잔액 환불',cap.balance_version,randomUUID()])).data;
   assert.equal(closed.new_balance,'0');assert.equal(closed.lifecycle_status,'refunded');
   await db.exec('reset role');await fails(()=>q('update customer_wallets set money_balance=1 where id=$1',[cashWallet.id]),'P0001');await user();
   const forbiddenUse=await treatmentCart('10');await fails(()=>use(forbiddenUse,cashWallet.id,forbiddenUse.lines[0].id,'money','1'),'P0001');
   const second=await save({sku:'CASH-2',name:'금액권 2',kind:'membership',sale_price:'100',benefit_money:'100',benefit_count:0});
   let sale=await addCatalog(await fresh(),second.id);sale=await ready(sale);await record(sale,'100');
   const secondWallet=(await wallets()).find(row=>row.product_id===second.id);
   await db.exec('reset role');await q('insert into staff_commission_settlements(organization_id,from_date,to_date) values($1,current_date,current_date)',[org]);await user();
   const secondCap=(await one('select preview_wallet_purchase_refund($1,$2,$3) data',[org,customer,secondWallet.id])).data;
   await fails(()=>one('select refund_wallet_purchase($1,$2,$3,$4,$5,$6,$7,true)',[org,customer,secondWallet.id,'10','기간 마감',secondCap.balance_version,randomUUID()]),'P0001');
  });
 }
 await db.exec('reset role');
 await q("update customer_wallets set expires_on=current_date+30 where id=$1",[wallet.id]);
 await user();
 if(process.argv.includes('--transfer')) await check('unused wallet transfer is manager-only, replay-safe and keeps its ledger',async()=>{
  let freshIssue=await addCatalog(await fresh(),membership.id);freshIssue=await ready(freshIssue);await record(freshIssue,'100');
  const transferWallet=(await one('select * from customer_wallets where sale_line_id=$1',[freshIssue.lines.find(line=>line.source_type==='membership').id]));
  const args=[org,customer,otherCustomer,transferWallet.id,1,'고객 양도 요청',randomUUID()];
  const moved=(await one('select transfer_customer_wallet($1,$2,$3,$4,$5,$6,$7) data',args)).data;
  assert.equal(moved.customer_id,otherCustomer);assert.equal(moved.owner_version,2);
  assert.deepEqual((await one('select transfer_customer_wallet($1,$2,$3,$4,$5,$6,$7) data',args)).data,moved);
  assert.equal((await wallets(customer)).some(row=>row.id===transferWallet.id),false);
  assert.equal((await wallets(otherCustomer)).some(row=>row.id===transferWallet.id),true);
  assert.equal((await one('select list_wallet_history($1,$2,$3) data',[org,otherCustomer,transferWallet.id])).data.some(event=>event.event_type==='transfer'),true);
  await user(member);await fails(()=>one('select transfer_customer_wallet($1,$2,$3,$4,$5,$6,$7)',args),'42501');await user();
  await fails(()=>one('select transfer_customer_wallet($1,$2,$3,$4,$5,$6,$7)',[org,customer,otherCustomer,transferWallet.id,1,'다른 내용',randomUUID()]),'P0002');
 });
 const lifecycle=async(action,version,days=null,reason='고객 요청',op=randomUUID())=>(await one(
  'select manage_customer_wallet($1,$2,$3,$4,$5,$6,$7,$8) data',
  [org,customer,wallet.id,action,days,reason,version,op])).data;
 await check('wallet pause blocks usage and resume preserves recorded balance',async()=>{
  const start=(await wallets())[0];const op=randomUUID();
  const paused=await lifecycle('pause',start.lifecycle_version,null,'일시 중지',op);
  assert.equal(paused.lifecycle_status,'paused');
  assert.deepEqual(await lifecycle('pause',start.lifecycle_version,null,'일시 중지',op),paused);
  await fails(()=>lifecycle('pause',start.lifecycle_version,1,'일시 중지',op),'22023');
  await fails(()=>lifecycle(null,start.lifecycle_version,null,'잘못된 동작'),'22023');
  await fails(()=>lifecycle('resume',start.lifecycle_version,null,'오래된 버전'),'P0001');
  const cart=await treatmentCart('10');
  await fails(()=>use(cart,wallet.id,cart.lines[0].id,'money','10'),'P0001');
  assert.equal((await wallets())[0].money_balance,start.money_balance);
  const resumed=await lifecycle('resume',paused.lifecycle_version,null,'다시 이용');
  assert.equal(resumed.lifecycle_status,'active');
  assert.equal(resumed.money_balance,start.money_balance);
  assert.equal((await use(cart,wallet.id,cart.lines[0].id,'money','10')).status,'paid');
 });
 await check('extension, role boundaries and immutable audit',async()=>{
  let current=(await wallets())[0];
  const original=current.expires_on;
  const op=randomUUID();
  const extended=await lifecycle('extend',current.lifecycle_version,7,'유효기간 연장',op);
  assert.equal(extended.expires_on,new Date(Date.parse(original+'T00:00:00Z')+7*86400000).toISOString().slice(0,10));
  assert.deepEqual(await lifecycle('extend',current.lifecycle_version,7,'유효기간 연장',op),extended);
  await fails(()=>lifecycle('extend',current.lifecycle_version,8,'유효기간 연장',op),'P0001');
  await user(member);await fails(()=>lifecycle('pause',extended.lifecycle_version,null,'권한 없음'),'42501');
  await user(outsider);await fails(()=>lifecycle('pause',extended.lifecycle_version,null,'다른 조직'),'42501');
  await user();
  await fails(()=>one('select manage_customer_wallet($1,$2,$3,$4,$5,$6,$7,$8)',
   [otherOrg,customer,wallet.id,'pause',null,'다른 조직',extended.lifecycle_version,randomUUID()]),'42501');
  await fails(()=>q("update wallet_lifecycle_events set reason='변경'"),'42501');
  current=(await wallets())[0];assert.equal(current.lifecycle_version,extended.lifecycle_version);
 });
 console.log(checks+' wallet usage checks passed');
}finally{await db.close();}
