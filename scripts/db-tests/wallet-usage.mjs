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
 create table customers(id uuid primary key,organization_id uuid not null,name text);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create table treatment_sale_drafts(id uuid primary key,organization_id uuid not null,customer_id uuid not null,description text not null,amount numeric(14,2) not null,source_snapshot jsonb not null);
 create table finance_transactions(id uuid primary key default gen_random_uuid(),organization_id uuid not null,transaction_type text not null,amount numeric(14,2) not null,transaction_date date not null,category text not null,counterparty text not null default '',memo text not null default '',is_archived boolean not null default false,created_by uuid not null,created_at timestamptz default now(),updated_at timestamptz default now());
 grant select,insert,update,delete on finance_transactions to authenticated;`);
 await q('insert into auth.users values($1),($2),($3)',[owner,member,outsider]);
 await q('insert into organizations values($1),($2)',[org,otherOrg]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[org,owner,member,otherOrg,outsider]);
 await q("insert into customers values($1,$2,'고객'),($3,$2,'다른 고객')",[customer,org,otherCustomer]);
 for(const name of ['024_visit_sale_carts.sql','025_visit_payments.sql','026_sale_cart_hardening_upgrade.sql','027_catalog_sales.sql','028_wallet_usage.sql'])
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
 await q("update customer_wallets set expires_on=current_date+30 where id=$1",[wallet.id]);
 await user();
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
