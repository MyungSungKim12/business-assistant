import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(),other=randomUUID(),owner=randomUUID(),admin=randomUUID(),member=randomUUID(),outsider=randomUUID();
const customer=randomUUID(),otherCustomer=randomUUID();
const q=(sql,values=[])=>db.query(sql,values);
const one=async(sql,values=[])=> (await q(sql,values)).rows[0];
const asUser=async(id)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const admin_=async()=>{await db.exec('reset role');};
const file=(name)=>readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8');
const addPhoto=(by,name='a.jpg',c=customer,o=org)=>one(`insert into customer_photos(organization_id,customer_id,uploaded_by,storage_path,original_name,content_type,size_bytes)
 values($1,$2,$3,$4,$5,'image/jpeg',1000) returning *`,[o,c,by,`${o}/${c}/${randomUUID()}-${name}`,name]);
const photo=(id)=>one('select * from customer_photos where id=$1',[id]);

try {
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
 grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key,email text);create table organizations(id uuid primary key);
 create table profiles(id uuid primary key references auth.users(id),display_name text not null default '');
 create table memberships(organization_id uuid,user_id uuid,role text);
 create table customers(id uuid primary key,organization_id uuid not null,name text,status text default 'active');
 create unique index customers_org_id on customers(id,organization_id);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;
 create function private.person_name(p_user uuid) returns text language sql stable security definer set search_path='' as $$
  select coalesce(nullif(btrim(p.display_name),''),nullif(split_part(u.email::text,'@',1),''),'이름 없음') from auth.users u left join public.profiles p on p.id=u.id where u.id=p_user $$;`);
 await q("insert into auth.users values($1,'owner@example.com'),($2,'admin@example.com'),($3,'member@example.com'),($4,'outsider@example.com')",[owner,admin,member,outsider]);
 await q("insert into profiles values($1,'원장'),($2,'')",[owner,admin]);
 await q('insert into organizations values($1),($2)',[org,other]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[org,owner,admin,member,other,outsider]);
 await q("insert into customers values($1,$2,'고객'),($3,$4,'타조직 고객')",[customer,org,otherCustomer,other]);
 // 022의 사진 테이블·정책 부분만 실행한다(뒤쪽은 Supabase storage 스키마를 쓴다).
 await db.exec((await file('022_customer_photos.sql')).split('-- The original generic file policy')[0]+'commit;');
 await db.exec(await file('053_customer_photo_trash.sql'));
 await db.exec(await file('053_customer_photo_trash.sql')); // 멱등

 // --- 삭제하면 DB가 시각·사람·이름·사유를 기록한다 ---
 await asUser(owner);
 const p1=await addPhoto(owner,'before.jpg');
 assert.equal(p1.archived_at,null);assert.equal(p1.archived_reason,'');
 const deleted=await one("update customer_photos set is_archived=true where id=$1 returning *",[p1.id]);
 assert.equal(deleted.is_archived,true);
 assert.ok(deleted.archived_at);assert.equal(deleted.archived_by,owner);assert.equal(deleted.archived_by_name,'원장');
 assert.equal(deleted.archived_reason,'deleted','사유를 주지 않은 삭제(예전 API)는 deleted로 본다');

 // --- 클라이언트가 보낸 값은 무시한다 ---
 const forged=await addPhoto(owner,'forged.jpg');
 const f2=await one("update customer_photos set is_archived=true,archived_by=$2,archived_by_name='위조',archived_at='2000-01-01' where id=$1 returning *",[forged.id,member]);
 assert.equal(f2.archived_by,owner);assert.equal(f2.archived_by_name,'원장');assert.ok(new Date(f2.archived_at).getFullYear()>=2024);
 await q("update customer_photos set archived_by_name='바꿈',archived_at='2001-01-01' where id=$1",[forged.id]);
 assert.equal((await photo(forged.id)).archived_by_name,'원장','삭제 상태에서 다른 필드를 고쳐도 기록은 유지된다');
 assert.equal(new Date((await photo(forged.id)).archived_at).getTime(),new Date(f2.archived_at).getTime());

 // --- 이름: 프로필 이름이 없으면 이메일 앞부분 ---
 await asUser(admin);
 const p3=await addPhoto(admin,'admin.jpg');
 const d3=await one("update customer_photos set is_archived=true where id=$1 returning *",[p3.id]);
 assert.equal(d3.archived_by_name,'admin');

 // --- 업로드 실패 정리는 휴지통 대상이 아니다 ---
 const failed=await addPhoto(admin,'failed.jpg');
 const d4=await one("update customer_photos set is_archived=true,archived_reason='upload_failed' where id=$1 returning *",[failed.id]);
 assert.equal(d4.archived_reason,'upload_failed');
 const trash=(await q("select id from customer_photos where organization_id=$1 and customer_id=$2 and is_archived and archived_reason='deleted' order by archived_at desc",[org,customer])).rows.map(r=>r.id);
 assert.deepEqual(trash.sort(),[p1.id,forged.id,p3.id].sort());
 await q("update customer_photos set archived_reason='deleted' where id=$1",[failed.id]);
 assert.equal((await photo(failed.id)).archived_reason,'upload_failed','삭제된 뒤에는 사유를 바꿀 수 없다');
 await assert.rejects(()=>q("insert into customer_photos(organization_id,customer_id,uploaded_by,storage_path,original_name,content_type,size_bytes,archived_reason) values($1,$2,$3,'p','x.jpg','image/jpeg',1,'x')",[org,customer,admin]),e=>e.code==='23514');

 // --- 복원하면 기록을 모두 지운다 ---
 const restored=await one('update customer_photos set is_archived=false where id=$1 returning *',[p1.id]);
 assert.equal(restored.is_archived,false);
 assert.equal(restored.archived_at,null);assert.equal(restored.archived_by,null);assert.equal(restored.archived_by_name,null);assert.equal(restored.archived_reason,'');
 // 복원 후 다시 삭제하면 새로 기록한다.
 await asUser(admin);
 const again=await one('update customer_photos set is_archived=true where id=$1 returning *',[p1.id]);
 assert.equal(again.archived_by,admin);assert.equal(again.archived_by_name,'admin');

 // --- 구성원은 읽기만, 수정·복원 불가 ---
 await asUser(member);
 assert.equal((await q('select * from customer_photos where organization_id=$1',[org])).rows.length,4);
 assert.equal((await q('update customer_photos set is_archived=false where id=$1',[p3.id])).affectedRows,0);
 assert.equal((await photo(p3.id)).is_archived,true);

 // --- 다른 조직 격리 ---
 await asUser(outsider);
 assert.equal((await q('select * from customer_photos where organization_id=$1',[org])).rows.length,0);
 assert.equal((await q('update customer_photos set is_archived=false where id=$1',[p3.id])).affectedRows,0);

 // --- 구성원에서 빠져도 삭제한 사람 이름은 남는다 ---
 await admin_();
 await q('delete from memberships where user_id=$1',[admin]);
 assert.equal((await photo(p3.id)).archived_by_name,'admin');
 console.log('PASS ops-053: customer photo trash — DB-stamped archive record, forged values ignored, restore clears, roles, tenants');
} finally {
 await db.close();
}
