import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(),other=randomUUID(),owner=randomUUID(),admin=randomUUID(),member=randomUUID(),outsider=randomUUID();
const q=(sql,values=[])=>db.query(sql,values);
const one=async(sql,values=[])=> (await q(sql,values)).rows[0];
const fail=(action,code)=>assert.rejects(action,error=>{assert.equal(error.code,code,error.message);return true;});
const asUser=async(id)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const file=(name)=>readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8');
const insert=(by,name,extra={})=>one(`insert into treatment_protocol_templates(organization_id,name,category,treatment_name,notes,consultation_goal,consultation_plan,created_by)
 values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[extra.org??org,name,extra.category??'피부',extra.treatment_name??'기본 관리',extra.notes??'1. 클렌징\n2. 팩',extra.goal??'수분 개선',extra.plan??'4주 간격',by]);

try {
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
 grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table memberships(organization_id uuid,user_id uuid,role text);
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;`);
 await q('insert into auth.users values($1),($2),($3),($4)',[owner,admin,member,outsider]);
 await q('insert into organizations values($1),($2)',[org,other]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[org,owner,admin,member,other,outsider]);
 await db.exec(await file('051_treatment_protocol_templates.sql'));
 await db.exec(await file('051_treatment_protocol_templates.sql')); // 멱등

 // --- owner/admin은 만들고 고치고 지운다 ---
 await asUser(owner);
 const t1=await insert(owner,'기본 페이셜');
 assert.equal(t1.version,1);assert.equal(t1.notes,'1. 클렌징\n2. 팩');
 await asUser(admin);
 const t2=await insert(admin,'왁싱 기본',{category:'왁싱',notes:''});
 assert.equal(t2.created_by,admin);

 // created_by는 기본값(auth.uid())이라 클라이언트가 보내지 않아도 호출한 사용자로 채워진다.
 await asUser(owner);
 const byDefault=await one("insert into treatment_protocol_templates(organization_id,name) values($1,'기본값 확인') returning *",[org]);
 assert.equal(byDefault.created_by,owner);
 await q('delete from treatment_protocol_templates where id=$1',[byDefault.id]);

 // --- 이름은 대소문자·공백을 무시하고 중복 불가 ---
 await asUser(admin);
 await fail(()=>insert(admin,'  기본 페이셜  '),'23505');
 await asUser(owner);
 await insert(owner,'Hydra Facial');
 await fail(()=>insert(owner,'hydra facial'),'23505');

 // --- 입력 한도 ---
 await fail(()=>insert(owner,''),'23514');
 await fail(()=>insert(owner,'가'.repeat(121)),'23514');
 await fail(()=>insert(owner,'노트 한도',{notes:'가'.repeat(10001)}),'23514');
 await fail(()=>insert(owner,'목표 한도',{goal:'가'.repeat(2001)}),'23514');
 await fail(()=>insert(owner,'계획 한도',{plan:'가'.repeat(5001)}),'23514');
 await fail(()=>insert(owner,'분류 한도',{category:'가'.repeat(101)}),'23514');
 await fail(()=>insert(admin,'작성자 위조'),'42501');

 // --- 수정은 버전을 올리고, 낙관적 잠금은 version 조건으로 건다 ---
 const updated=await one("update treatment_protocol_templates set notes='1. 클렌징\n2. 팩\n3. 마무리' where id=$1 and version=$2 returning *",[t1.id,1]);
 assert.equal(updated.version,2);assert.ok(new Date(updated.updated_at)>=new Date(t1.updated_at));
 assert.equal(new Date(updated.created_at).getTime(),new Date(t1.created_at).getTime());
 const stale=await q("update treatment_protocol_templates set notes='덮어쓰기' where id=$1 and version=$2 returning *",[t1.id,1]);
 assert.equal(stale.rows.length,0,'오래된 버전으로는 수정되지 않는다');
 assert.equal((await one('select notes from treatment_protocol_templates where id=$1',[t1.id])).notes,'1. 클렌징\n2. 팩\n3. 마무리');
 await fail(()=>q('update treatment_protocol_templates set organization_id=$2 where id=$1',[t1.id,other]),'42501');
 await fail(()=>q('update treatment_protocol_templates set created_by=$2 where id=$1',[t1.id,admin]),'42501');

 // --- 구성원은 읽기만 ---
 await asUser(member);
 assert.equal((await q('select * from treatment_protocol_templates where organization_id=$1',[org])).rows.length,3);
 await fail(()=>insert(member,'구성원 작성'),'42501');
 assert.equal((await q("update treatment_protocol_templates set notes='x' where id=$1",[t1.id])).affectedRows,0);
 assert.equal((await q('delete from treatment_protocol_templates where id=$1',[t1.id])).affectedRows,0);
 assert.equal((await one('select notes from treatment_protocol_templates where id=$1',[t1.id])).notes.includes('마무리'),true);

 // --- 다른 조직 격리 ---
 await asUser(outsider);
 assert.equal((await q('select * from treatment_protocol_templates where organization_id=$1',[org])).rows.length,0);
 await fail(()=>insert(outsider,'침입',{org}),'42501');
 assert.equal((await q('delete from treatment_protocol_templates where id=$1',[t1.id])).affectedRows,0);

 // --- 관리자는 지울 수 있다 ---
 await asUser(admin);
 assert.equal((await q('delete from treatment_protocol_templates where id=$1',[t2.id])).affectedRows,1);
 await asUser(owner);
 assert.equal((await q('select * from treatment_protocol_templates where organization_id=$1',[org])).rows.length,2);
 console.log('PASS ops-051: treatment protocol templates — roles, unique names, limits, version bump, optimistic lock, tenants');
} finally {
 await db.close();
}
