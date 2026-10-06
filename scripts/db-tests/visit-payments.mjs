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
 const created=(await one('select create_customer_visit($1,$2,$3) data',[org,customer,randomUUID()])).data;
 const visit=created.visit.id;
 const added=(await one('select add_treatment_draft_to_cart($1,$2,$3,$4,$5) data',[org,visit,draft,created.cart.version,randomUUID()])).data;
 const ready=(await one('select review_sale_cart($1,$2,$3,$4,true) data',[org,visit,added.cart.version,randomUUID()])).data;
 let version=Number(ready.cart.version),otherVisit;
 await check('member read, outsider and cross-organization isolation',async()=>{
  await user(member);assert.equal((await get(visit)).status,'ready');await fails(()=>record(visit,version,[payment('cash','1')]),'42501');
  await user(outsider);await fails(()=>get(visit),'42501');await fails(()=>record(visit,version,[payment('cash','1')]),'42501');
  await user();await fails(()=>one('select get_visit_payments($1,$2)',[otherOrg,visit]),'42501');
 });
 await check('reject malformed requests and leave no receipt',async()=>{
  for(const items of [null,[],[payment('cash',null)],[payment('cash',1)],[payment('cash','1.5')],[payment('cash','0')],[payment('cash','01')],[payment('cash',' 1')],[payment('cash','1000000000000')],[payment('card','1')],[payment('transfer','1')],[payment('cash','1'),payment('cash','2')],[{method:'cash',amount:'1',reference:'',extra:1}],[{method:'cash',amount:'1'}],[payment('card','1','x'.repeat(201))]])
   await fails(()=>record(visit,version,items),'22023');
  await fails(()=>record(visit,null,[payment('cash','1')]),'22023');
  await fails(()=>record(visit,version,[payment('cash','1')],randomUUID(),false),'22023');
  assert.equal((await get(visit)).receipts.length,0);
 });
 await check('partial payment, linked finance rows, exact replay',async()=>{
  const op=randomUUID(),items=[payment('card','70000','AUTH-1')];
  const first=await record(visit,version,items,op);assert.equal(first.status,'collecting');assert.equal(Number(first.paid_amount),70000);assert.equal(Number(first.outstanding_amount),30000);assert.equal(first.receipts.length,1);
  assert.deepEqual(await record(visit,version,items,op),first);
  await fails(()=>record(visit,version,[payment('card','70001','AUTH-1')],op),'P0001');
  await user(admin);await fails(()=>record(visit,version,items,op),'P0001');await user();
  version=Number(first.cart_version);
  const ledger=await one('select count(*)::int n,sum(amount) total from finance_transactions');assert.equal(ledger.n,1);assert.equal(Number(ledger.total),70000);
  const dated=await one("select count(*)::int n from visit_payment_receipts r join finance_transactions f on f.id=r.finance_transaction_id where f.transaction_date=(r.received_at at time zone 'Asia/Seoul')::date");assert.equal(dated.n,1);
  const current=await one('select status from customer_visits where id=$1',[visit]);assert.equal(current.status,'checkout_ready');
  await fails(()=>record(visit,version,[payment('card','1','AUTH-1')]),'23505');
  await fails(()=>record(visit,version,[payment('card','1','auth-1')]),'23505');
  await fails(()=>record(visit,version,[payment('cash','30001')]),'22023');
  await fails(()=>record(visit,version,[payment('cash','1'),payment('card','1','AUTH-1')]),'23505');
  assert.equal((await get(visit)).receipts.length,1);
  assert.equal((await one('select count(*)::int n from finance_transactions')).n,1);
 });
 await check('frozen cart and protected finance receipt',async()=>{
  await fails(()=>one('select mutate_sale_cart_line($1,$2,$3,$4,$5,$6,$7::jsonb)',[org,visit,added.lines[0].id,version,randomUUID(),'update',JSON.stringify({quantity:2})]),'P0001');
  await fails(()=>one('select review_sale_cart($1,$2,$3,$4,true)',[org,visit,version,randomUUID()]),'P0001');
  await fails(()=>q("update finance_transactions set is_archived=true where category='Visit payment'"),'P0001');
  await fails(()=>q("delete from finance_transactions where category='Visit payment'"),'P0001');
  await db.exec('reset role');
  await fails(()=>q('update visit_payment_receipts set reference=$1',["changed"]),'P0001');
  await fails(()=>q('delete from visit_payment_receipts'),'P0001');
  await user();
 });
 await check('fractional cart cannot accept whole KRW receipts',async()=>{
  const fractionalDraft=randomUUID();
  await db.exec('reset role');
  await q("insert into treatment_sale_drafts values($1,$2,$3,'fractional',1.50,'{}'::jsonb)",[fractionalDraft,org,customer]);
  await user();
  const fresh=(await one('select create_customer_visit($1,$2,$3) data',[org,customer,randomUUID()])).data;
  otherVisit=fresh.visit.id;
  const addedFraction=(await one('select add_treatment_draft_to_cart($1,$2,$3,$4,$5) data',[org,fresh.visit.id,fractionalDraft,fresh.cart.version,randomUUID()])).data;
  const reviewed=(await one('select review_sale_cart($1,$2,$3,$4,true) data',[org,fresh.visit.id,addedFraction.cart.version,randomUUID()])).data;
  await fails(()=>record(fresh.visit.id,reviewed.cart.version,[payment('cash','1')]),'22023');
  assert.equal((await get(fresh.visit.id)).receipts.length,0);
 });
 await check('privileged receipt insert rejects mismatched cart, visit and finance attributes',async()=>{
  await db.exec('reset role');
  const before=(await one('select count(*)::int n from finance_transactions')).n;
  const bad=async({receiptVisit=visit,financeOrg=org,type='income',amount=1,creator=owner,archived=false}={})=>{
   await db.exec('begin');
   try{
    const finance=(await one("insert into finance_transactions(organization_id,transaction_type,amount,transaction_date,category,is_archived,created_by) values($1,$2,$3,current_date,'Visit payment',$4,$5) returning id",[financeOrg,type,amount,archived,creator])).id;
    await q('insert into visit_payment_receipts(organization_id,cart_id,visit_id,operation_id,method,amount,reference,created_by,finance_transaction_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[org,ready.cart.id,receiptVisit,randomUUID(),'cash',1,'',owner,finance]);
    assert.fail('mismatched receipt inserted');
   }finally{await db.exec('rollback');}
  };
  await fails(()=>bad({receiptVisit:otherVisit}),'23503');
  await fails(()=>bad({financeOrg:otherOrg}),'23503');
  await fails(()=>bad({type:'expense'}),'P0001');
  await fails(()=>bad({amount:2}),'P0001');
  await fails(()=>bad({creator:admin}),'P0001');
  await fails(()=>bad({archived:true}),'P0001');
  assert.equal((await one('select count(*)::int n from finance_transactions')).n,before);
  await user();
 });
 await check('final payment closes visit without overcollection',async()=>{
  const final=await record(visit,version,[payment('cash','10000'),payment('transfer','20000','TR-1')]);assert.equal(final.status,'paid');assert.equal(Number(final.outstanding_amount),0);assert.equal(final.receipts.length,3);
  assert.equal((await one('select status from customer_visits where id=$1',[visit])).status,'closed');
  await fails(()=>record(visit,Number(final.cart_version),[payment('cash','1')]),'P0001');
  const ledger=await one('select count(*)::int n,sum(amount) total from finance_transactions');assert.equal(ledger.n,3);assert.equal(Number(ledger.total),100000);
 });
 await check('hardening upgrade preserves paid balances and receipt history',async()=>{
  const before=await get(visit);
  await db.exec('reset role');
  await db.exec(await readFile(new URL('../../migrations/026_sale_cart_hardening_upgrade.sql',import.meta.url),'utf8'));
  await user();
  assert.deepEqual(await get(visit),before);
  await fails(()=>one('select review_sale_cart($1,$2,$3,$4,false)',[org,visit,Number(before.cart_version),randomUUID()]),'P0001');
 });
 console.log(`${checks} visit payment checks passed`);
}finally{await db.close();}
