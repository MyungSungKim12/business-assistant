import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(),otherOrg=randomUUID(),owner=randomUUID(),otherManager=randomUUID(),member=randomUUID(),outsider=randomUUID();
const customer=randomUUID(),foreignCustomer=randomUUID(),draft=randomUUID();
const q=(sql,params=[])=>db.query(sql,params),one=async(sql,params=[])=>(await q(sql,params)).rows[0];
const fails=(fn,code)=>assert.rejects(fn,error=>{assert.equal(error.code,code,error.message);return true;});
const user=async(id=owner)=>{await db.exec('reset role; set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const createVisit=(customerId=customer,operation=randomUUID())=>one('select create_customer_visit($1,$2,$3) data',[org,customerId,operation]);
const add=(visit,version,operation=randomUUID())=>one('select add_treatment_draft_to_cart($1,$2,$3,$4,$5) data',[org,visit,draft,version,operation]);
const mutate=(visit,line,version,action,values,operation=randomUUID())=>one('select mutate_sale_cart_line($1,$2,$3,$4,$5,$6,$7::jsonb) data',[org,visit,line,version,operation,action,JSON.stringify(values)]);
const ledgerCount=async()=>{await db.exec('reset role');const row=await one('select count(*)::int n from finance_transactions');await user();return row.n;};
let checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log(`PASS ${name}`);};

try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
 grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table memberships(organization_id uuid,user_id uuid,role text);
 create table customers(id uuid primary key,organization_id uuid not null,name text);
 create table finance_transactions(id uuid primary key default gen_random_uuid(),organization_id uuid);
 create table treatment_sale_drafts(id uuid primary key,organization_id uuid not null,customer_id uuid not null,description text not null,amount numeric(14,2) not null,source_snapshot jsonb not null);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;`);
 await q('insert into auth.users values($1),($2),($3),($4)',[owner,otherManager,member,outsider]);
 await q('insert into organizations values($1),($2)',[org,otherOrg]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[org,owner,otherManager,member,otherOrg,outsider]);
 await q("insert into customers values($1,$2,'고객'),($3,$4,'외부 고객')",[customer,org,foreignCustomer,otherOrg]);
 await q("insert into treatment_sale_drafts values($1,$2,$3,'피부 관리',12000.50,$4::jsonb)",[draft,org,customer,JSON.stringify({customer:{name:'고객'},treatment:{practitioner:'담당자'}})]);
 await db.exec(await readFile(new URL('../../migrations/024_visit_sale_carts.sql',import.meta.url),'utf8'));
 await user();
 let visit,cart,line;
 await check('atomic visit creation and exact operation replay',async()=>{
  const operation=randomUUID(),first=(await createVisit(customer,operation)).data,replay=(await createVisit(customer,operation)).data;
  assert.deepEqual(replay,first);visit=first.visit;cart=first.cart;assert.deepEqual(first.lines,[]);
  await user(otherManager);await fails(()=>createVisit(customer,operation),'P0001');await user();
  await fails(()=>createVisit(foreignCustomer,operation),'P0001');await fails(()=>createVisit(foreignCustomer),'P0002');
 });
 await check('membership read and manager mutation boundaries',async()=>{
  await user(member);assert.equal((await q('select * from customer_visits')).rows.length,1);await fails(()=>createVisit(),'42501');
  await user(outsider);assert.equal((await q('select * from customer_visits')).rows.length,0);await fails(()=>createVisit(),'42501');await user();
 });
 await check('replay belongs to original actor and read RPC is scoped',async()=>{
  await fails(()=>one('select get_visit_sale_cart($1,$2)',[otherOrg,visit.id]),'42501');
  await user(member);
  const read=(await one('select get_visit_sale_cart($1,$2) data',[org,visit.id])).data;
  assert.equal(read.visit.id,visit.id);assert.equal(read.cart.id,cart.id);
  await user(outsider);
  await fails(()=>one('select get_visit_sale_cart($1,$2)',[org,visit.id]),'42501');
  await fails(()=>one('select get_visit_sale_cart($1,$2)',[otherOrg,visit.id]),'P0002');
  await user();
 });
 await check('draft add is idempotent, versioned and has no ledger side effect',async()=>{
  const operation=randomUUID(),result=(await add(visit.id,Number(cart.version),operation)).data;
  cart=result.cart;line=result.lines[0];assert.equal(Number(cart.total_amount),12000.50);
  assert.deepEqual((await add(visit.id,1,operation)).data,result);assert.equal(await ledgerCount(),0);
  await user(otherManager);await fails(()=>add(visit.id,1,operation),'P0001');await user();
  const second=(await createVisit()).data;
  await fails(()=>add(second.visit.id,second.cart.version),'P0001');
  await fails(()=>add(visit.id,1),'P0001');
 });
 await check('invalid requests and precision are rejected before mutation',async()=>{
  await fails(()=>add(visit.id,0),'22023');
  await fails(()=>mutate(visit.id,line.id,null,null,{}),'22023');
  await fails(()=>mutate(visit.id,line.id,cart.version,'update',{unit_price:'0.001'}),'22023');
  await fails(()=>mutate(visit.id,line.id,cart.version,'update',{unit_price:'NaN'}),'22023');
  await fails(()=>mutate(visit.id,line.id,cart.version,'update',{quantity:1.5}),'22023');
  await fails(()=>mutate(visit.id,line.id,cart.version,'update',{quantity:'2'}),'22023');
  await fails(()=>mutate(visit.id,line.id,cart.version,'update',{unit_price:1e12}),'22023');
  await fails(()=>mutate(visit.id,line.id,cart.version,'update',{staff_name:42}),'22023');
  await fails(()=>mutate(visit.id,line.id,cart.version,'update',{staff_name:'x'.repeat(201)}),'22023');
  await fails(()=>mutate(visit.id,line.id,cart.version,'remove',{reason:'ok',extra:1}),'22023');
  await fails(()=>mutate(visit.id,line.id,cart.version,'restore',{extra:1}),'22023');
  await fails(()=>mutate(visit.id,line.id,cart.version,'update',{staff_id:outsider}),'22023');
  await fails(()=>mutate(visit.id,line.id,cart.version,'update',{staff_id:'not-a-uuid'}),'22023');
  await fails(()=>one('select review_sale_cart($1,$2,$3,$4,true)',[org,visit.id,0,randomUUID()]),'22023');
  await fails(()=>one('select cancel_customer_visit($1,$2,$3,$4)',[org,visit.id,null,randomUUID()]),'22023');
 });
 await check('aggregate amount overflow rejects the add and rolls it back',async()=>{
  const expensiveDraft=randomUUID(),operation=randomUUID();
  await db.exec('reset role');
  await q("insert into treatment_sale_drafts values($1,$2,$3,'고가 시술',999999999999.99,'{}'::jsonb)",[expensiveDraft,org,customer]);
  await user();
  await fails(()=>one('select add_treatment_draft_to_cart($1,$2,$3,$4,$5)',[org,visit.id,expensiveDraft,cart.version,operation]),'22023');
  const after=(await one('select get_visit_sale_cart($1,$2) data',[org,visit.id])).data;
  assert.equal(after.cart.version,cart.version);
  assert.equal(after.lines.length,1);
  assert.equal((await one('select count(*)::int n from sale_cart_operations where organization_id=$1 and operation_id=$2',[org,operation])).n,0);
 });
 await check('line update, remove and restore recalculate totals without deleting audit row',async()=>{
  await fails(()=>mutate(visit.id,line.id,1,'update',{quantity:2}),'P0001');
  let result=(await mutate(visit.id,line.id,Number(cart.version),'update',{quantity:2,unit_price:'100.25',staff_name:'새 담당'})).data;
  cart=result.cart;assert.equal(Number(cart.total_amount),200.50);assert.equal(result.lines[0].staff_name_snapshot,'새 담당');
  await fails(()=>mutate(visit.id,line.id,Number(cart.version),'remove',{reason:' '}),'22023');
  result=(await mutate(visit.id,line.id,Number(cart.version),'remove',{reason:'고객 요청'})).data;cart=result.cart;
  assert.equal(result.lines[0].status,'removed');assert.equal(Number(cart.total_amount),0);
  result=(await mutate(visit.id,line.id,Number(cart.version),'restore',{})).data;cart=result.cart;
  assert.equal(result.lines[0].id,line.id);assert.equal(result.lines[0].status,'active');
 });
 await check('review and cancel transitions never create finance transactions',async()=>{
  let result=(await one('select review_sale_cart($1,$2,$3,$4,true) data',[org,visit.id,cart.version,randomUUID()])).data;
  cart=result.cart;visit=result.visit;assert.equal(cart.status,'ready');assert.equal(visit.status,'checkout_ready');
  result=(await mutate(visit.id,line.id,Number(cart.version),'update',{quantity:2})).data;
  cart=result.cart;visit=result.visit;assert.equal(cart.status,'draft');assert.equal(visit.status,'open');
  assert.equal(Number(visit.version),3);
  result=(await one('select review_sale_cart($1,$2,$3,$4,true) data',[org,visit.id,cart.version,randomUUID()])).data;
  cart=result.cart;visit=result.visit;
  await fails(()=>one('select cancel_customer_visit($1,$2,$3,$4)',[org,visit.id,visit.version,randomUUID()]),'22023');
  result=(await mutate(visit.id,line.id,Number(cart.version),'remove',{reason:'방문 취소'})).data;cart=result.cart;
  visit=await one('select * from customer_visits where id=$1',[visit.id]);
  result=(await one('select cancel_customer_visit($1,$2,$3,$4) data',[org,visit.id,visit.version,randomUUID()])).data;
  assert.equal(result.visit.status,'canceled');assert.equal(result.cart.status,'void');
  assert.equal(await ledgerCount(),0);
 });
 console.log(`${checks} visit sale cart checks passed`);
}finally{await db.close();}
