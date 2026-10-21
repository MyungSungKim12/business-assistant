import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite(),org=randomUUID(),otherOrg=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID(),product=randomUUID(),file=randomUUID(),otherFile=randomUUID();
const q=(sql,params=[])=>db.query(sql,params),one=async(sql,params=[])=> (await q(sql,params)).rows[0];
const as=async(id)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);create table memberships(organization_id uuid,user_id uuid,role text);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create function private.assert_sale_cart_manager(target uuid) returns void language plpgsql security definer set search_path='' as $$begin if auth.uid() is null or not private.has_organization_role(target,array['owner','admin']::text[]) then raise exception 'Manager required' using errcode='42501';end if;end$$;
 create table file_assets(id uuid primary key,organization_id uuid,content_type text,size_bytes bigint,is_archived boolean default false);
 create table catalog_products(id uuid primary key,organization_id uuid,version bigint default 1,image_file_id uuid,unique(organization_id,id));
 create table sale_cart_operations(organization_id uuid,operation_id uuid,actor_id uuid,action text,request_fingerprint text,result_snapshot jsonb,created_at timestamptz,primary key(organization_id,operation_id));
 create function private.catalog_payload(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$select to_jsonb(p) from public.catalog_products p where id=p_id$$;
 insert into auth.users values('${owner}'),('${member}'),('${outsider}');insert into organizations values('${org}'),('${otherOrg}');insert into memberships values('${org}','${owner}','owner'),('${org}','${member}','member');
 insert into catalog_products(id,organization_id) values('${product}','${org}');
 insert into file_assets values('${file}','${org}','image/webp',100000,false),('${otherFile}','${otherOrg}','image/png',1000,false);`);
 await db.exec(await readFile(new URL('../../migrations/080_catalog_product_images.sql',import.meta.url),'utf8'));
 await as(owner);
 const save=(image,version=1,op=randomUUID())=>one('select set_catalog_product_image($1,$2,$3,$4,$5) data',[org,product,image,version,op]);
 const op=randomUUID(),saved=(await save(file,1,op)).data;assert.equal(saved.image_file_id,file);assert.equal(saved.version,2);
 assert.deepEqual((await save(file,1,op)).data,saved);
 await assert.rejects(()=>save(otherFile,2),e=>e.code==='22023');
 await assert.rejects(()=>save(file,1),e=>e.code==='P0001');
 await db.exec('reset role');
 await q("insert into file_assets values($1,$2,'image/gif',100,false)",[randomUUID(),org]);
 const gif=(await one("select id from file_assets where content_type='image/gif'")).id;
 await assert.rejects(()=>save(gif,2),e=>e.code==='22023');
 await q('update file_assets set is_archived=true where id=$1',[file]).catch(e=>assert.equal(e.code,'23503'));
 const unlink=randomUUID();await save(null,2,unlink);await q('update file_assets set is_archived=true where id=$1',[file]);
 await as(member);await assert.rejects(()=>save(file,3),e=>e.code==='42501');
 await as(outsider);await assert.rejects(()=>save(file,3),e=>e.code==='42501');
 console.log('PASS INV-11 product image size/type/org validation, manager write, replay, version lock and unlink-before-archive');
}finally{await db.close();}
