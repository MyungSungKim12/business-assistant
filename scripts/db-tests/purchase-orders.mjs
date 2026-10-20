import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db=new PGlite(),org=randomUUID(),other=randomUUID(),owner=randomUUID(),member=randomUUID(),customer=randomUUID();
const q=(sql,args=[])=>db.query(sql,args),one=async(sql,args=[]) => (await q(sql,args)).rows[0];
const fail=(fn,code)=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true});
const user=async(id=owner)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const migration=async(name)=>db.exec(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key,email text);create table organizations(id uuid primary key);create table memberships(organization_id uuid,user_id uuid,role text);
 create table customers(id uuid primary key,organization_id uuid not null,name text,status text default 'active');create unique index customers_org_id on customers(id,organization_id);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create table treatment_sale_drafts(id uuid primary key,organization_id uuid not null,customer_id uuid not null,description text not null,amount numeric(14,2) not null,source_snapshot jsonb not null);
 create table finance_transactions(id uuid primary key default gen_random_uuid(),organization_id uuid not null,transaction_type text not null,amount numeric(14,2) not null,transaction_date date not null,category text not null,counterparty text not null default '',memo text not null default '',is_archived boolean not null default false,created_by uuid not null,created_at timestamptz default now(),updated_at timestamptz default now());grant select,insert,update,delete on finance_transactions to authenticated;`);
 await q('insert into auth.users values($1,$2),($3,$4)',[owner,'owner@x',member,'member@x']);await q('insert into organizations values($1),($2)',[org,other]);await q("insert into memberships values($1,$2,'owner'),($1,$3,'member')",[org,owner,member]);await q("insert into customers values($1,$2,'고객','active')",[customer,org]);
 for(const file of ['024_visit_sale_carts.sql','025_visit_payments.sql','026_sale_cart_hardening_upgrade.sql','027_catalog_sales.sql','030_inventory_stock_controls.sql','058_purchase_orders.sql'])await migration(file);
 await user();
 const product=(await one('select save_catalog_product($1,null,null,$2,$3::jsonb) data',[org,randomUUID(),JSON.stringify({sku:'P1',name:'상품',kind:'product',unit_name:'개',sale_price:'100',benefit_money:'0',benefit_count:0,valid_days:null,is_active:true})])).data;
 await one('select create_catalog_supplier($1,$2::jsonb)',[org,JSON.stringify({name:'공급처',contact_name:'',phone:'',email:'',note:'',is_active:true})]);const supplier=(await one('select to_jsonb(s) data from catalog_suppliers s where organization_id=$1',[org])).data;
 const op=randomUUID(),lines=[{product_id:product.id,quantity_ordered:5,unit_cost:'1200',note:''}];
 const create=async(supplierId=supplier.id,ls=lines)=> (await one('select create_catalog_purchase_order($1,$2,$3,$4,$5::jsonb) data',[org,supplierId,op,'',JSON.stringify(ls)])).data;
 const order=await create();assert.equal(order.lines[0].quantity_received,0);assert.deepEqual(await create(),order);await fail(()=>create(supplier.id,[{...lines[0],quantity_ordered:4}]),'P0001');
 await one("select update_catalog_purchase_order($1,$2,'ordered',1)",[org,order.id]);
 const line=order.lines[0],receiptOp=randomUUID();const receive=async(qty,oid=receiptOp)=>one('select receive_catalog_purchase_order_line($1,$2,$3,$4,$5)',[org,order.id,line.id,qty,oid]);
 await receive(2);await receive(2,randomUUID());await fail(()=>receive(4,randomUUID()),'22023');
 const current=(await one('select stock_quantity from catalog_products where id=$1',[product.id])).stock_quantity;assert.equal(current,4);
 const movement=await one("select movement_kind,quantity from catalog_stock_ledger where product_id=$1 order by created_at desc limit 1",[product.id]);assert.deepEqual(movement,{movement_kind:'purchase_order_receipt',quantity:2});
 await user(member);await fail(()=>one('select create_catalog_supplier($1,$2::jsonb)',[org,'{"name":"No"}']),'42501');
 await db.exec('reset role');console.log('PASS purchase order creation, retry conflict, partial receiving, stock ledger and manager permission');
}finally{await db.close();}



