import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const org=randomUUID(), owner=randomUUID(), member=randomUUID();
const customer=randomUUID(), treatment=randomUUID(), template=randomUUID();
const q=(s,p=[])=>db.query(s,p), one=async(s,p)=>(await q(s,p)).rows[0];
const fails=(fn,code)=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
async function user(id=owner){await db.exec('reset role; set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);}
const preview=async()=>(await one('select public.preview_treatment_document($1,$2,$3,$4) as data',[org,customer,treatment,template])).data;
const issue=(p,op=randomUUID())=>one('select * from public.issue_treatment_document($1,$2,$3,$4,$5,$6::jsonb)',[org,customer,treatment,template,op,JSON.stringify(p)]);
async function content(text){await db.exec('reset role');await q('update document_template_versions set content=$1 where template_id=$2',[text,template]);await user();}
const asAdmin=async(sql,params=[])=>{await db.exec('reset role');await q(sql,params);await user();};
const kstToday=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
const file=(name)=>readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8');

try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
 grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key,name text not null default '');
 create table memberships(organization_id uuid,user_id uuid,role text);
 create table customers(id uuid primary key,organization_id uuid not null,name text,phone text,updated_at timestamptz default now());
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;`);
 await q('insert into auth.users values($1),($2)',[owner,member]);
 await q("insert into organizations values($1,'베이지 살롱')",[org]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'member')",[org,owner,member]);
 await q("insert into customers(id,organization_id,name,phone) values($1,$2,'홍길동','01012345678')",[customer,org]);
 for(const f of ['007_documents.sql','014_customer_records.sql','016_treatment_lifecycle.sql','017_treatment_consultation.sql','018_document_template_versions.sql','019_treatment_document_issuance.sql']) await db.exec(await file(f));
 await q("update customers set skin_type='건성',allergies='향료 알레르기',birth_date='1990-05-21' where id=$1",[customer]);
 await q(`insert into treatment_records(id,organization_id,customer_id,treatment_name,category,practitioner,amount,next_visit_date,consultation_goal,consultation_plan,created_by)
  values($1,$2,$3,'수분 관리','피부','김담당',15000,'2026-12-01','수분 개선','4주 간격',$4)`,[treatment,org,customer,owner]);
 await user();
 await q("select * from mutate_document_template($1,$2,0,$3,'create',$4::jsonb)",[org,template,randomUUID(),JSON.stringify({name:'동의서',description:'',content:'{{customer.name}} / {{treatment.name}} / {{treatment.amount}}'})]);
 await q("select * from mutate_document_template($1,$2,1,$3,'publish','{}')",[org,template,randomUUID()]);

 // 054 적용 전: 새 항목은 알 수 없는 항목이라 누락으로 막힌다.
 await content('{{organization.name}}');
 assert.deepEqual((await preview()).missing_fields,['organization.name']);

 await db.exec('reset role');
 await db.exec(await file('054_document_template_fields.sql'));
 await db.exec(await file('054_document_template_fields.sql')); // 멱등
 await user();

 // 1) 기존 항목의 결과는 그대로다.
 await content('{{customer.name}} / {{treatment.name}} / {{treatment.amount}}');
 const old=await preview();
 assert.equal(old.content,'홍길동 / 수분 관리 / 15000.00');assert.deepEqual(old.missing_fields,[]);

 // 2) 새 항목이 모두 채워진다.
 await content('{{organization.name}}|{{today}}|{{customer.skin_type}}|{{customer.allergies}}|{{treatment.category}}|{{treatment.next_visit_date}}|{{treatment.consultation_plan}}');
 const filled=await preview();
 assert.deepEqual(filled.missing_fields,[]);
 assert.equal(filled.content,`베이지 살롱|${kstToday()}|건성|향료 알레르기|피부|2026-12-01|4주 간격`);

 // 3) 스냅샷에 새 값이 함께 남는다.
 const snap=filled.source_snapshot;
 assert.equal(snap.organization.name,'베이지 살롱');assert.equal(snap.issued_on,kstToday());
 assert.equal(snap.customer.skin_type,'건성');assert.equal(snap.customer.allergies,'향료 알레르기');
 assert.equal(snap.treatment.category,'피부');assert.equal(snap.treatment.next_visit_date,'2026-12-01');assert.equal(snap.treatment.consultation_plan,'4주 간격');
 assert.equal(snap.customer.name,'홍길동','기존 스냅샷 키는 그대로');

 // 4) 발행하면 그 시점의 값이 고정되고, 이후 고객 정보를 바꿔도 발행본은 변하지 않는다.
 const op=randomUUID();
 const issued=await issue(filled,op);
 assert.equal(issued.content,filled.content);
 await asAdmin("update customers set allergies='변경됨' where id=$1",[customer]);
 assert.equal((await one('select content from issued_treatment_documents where id=$1',[issued.id])).content,filled.content);
 assert.equal((await issue(filled,op)).id,issued.id,'같은 작업 재시도는 같은 발행본');
 await fails(()=>issue(filled),'P0001'); // 고객 정보가 바뀌어 이전 미리보기는 낡았다

 // 5) 비어 있는 값은 누락으로 보고 발행을 막는다(없음을 자동으로 채우지 않는다).
 await asAdmin("update customers set allergies='',skin_type=null where id=$1",[customer]);
 await asAdmin('update treatment_records set category=$2,next_visit_date=null,consultation_plan=$3 where id=$1',[treatment,'','']);
 const blank=await preview();
 assert.deepEqual(blank.missing_fields,['customer.skin_type','customer.allergies','treatment.category','treatment.next_visit_date','treatment.consultation_plan']);
 await fails(()=>issue(blank),'22023');
 await asAdmin("update organizations set name='' where id=$1",[org]);
 assert.ok((await preview()).missing_fields.includes('organization.name'));

 // 6) 구성원은 미리보기만 하고 발행·내부 함수 호출은 못 한다.
 await asAdmin("update organizations set name='베이지 살롱' where id=$1",[org]);
 await content('{{organization.name}} {{today}}');
 await user(member);
 assert.equal((await preview()).content,`베이지 살롱 ${kstToday()}`);
 await fails(()=>q('select private.render_treatment_document($1,$2,$3,$4)',[org,customer,treatment,template]),'42501');
 await user();

 // 7) 중괄호 오류·알 수 없는 항목은 여전히 막는다.
 await content('{{customer.nickname}} {{today');
 const bad=await preview();
 assert.ok(bad.missing_fields.includes('customer.nickname')&&bad.missing_fields.includes('malformed_placeholder'));
 await fails(()=>issue(bad),'22023');
 console.log('PASS ops-054: document template fields — new fields render, snapshot, issue immutability, blank blocks, access');
}finally{await db.close();}
