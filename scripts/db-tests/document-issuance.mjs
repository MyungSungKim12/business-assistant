import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const org=randomUUID(), other=randomUUID(), owner=randomUUID(), member=randomUUID(), outsider=randomUUID();
const customer=randomUUID(), treatment=randomUUID(), template=randomUUID();
const q=(s,p=[])=>db.query(s,p), one=async(s,p)=>(await q(s,p)).rows[0];
let checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log(`PASS ${name}`);};
const fails=(fn,code)=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
async function user(id=owner,role='authenticated'){await db.exec(`reset role; set role ${role}`);await q("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);}
const preview=async(c=customer,t=treatment,tp=template,o=org)=>(await one('select public.preview_treatment_document($1,$2,$3,$4) as data',[o,c,t,tp])).data;
const issue=(p,op=randomUUID(),tp=template)=>one('select * from public.issue_treatment_document($1,$2,$3,$4,$5,$6::jsonb)',[org,customer,treatment,tp,op,JSON.stringify(p)]);
async function content(text){await db.exec('reset role');await q('update document_template_versions set content=$1 where template_id=$2',[text,template]);await user();}
try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
 grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table memberships(organization_id uuid,user_id uuid,role text);
 create table customers(id uuid primary key,organization_id uuid not null,name text,phone text,updated_at timestamptz default now());
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;`);
 await q('insert into auth.users values($1),($2),($3)',[owner,member,outsider]);
 await q('insert into organizations values($1),($2)',[org,other]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[org,owner,member,other,outsider]);
 await q("insert into customers(id,organization_id,name,phone) values($1,$2,'홍길동','01012345678')",[customer,org]);
 for(const file of ['007_documents.sql','014_customer_records.sql','016_treatment_lifecycle.sql','017_treatment_consultation.sql','018_document_template_versions.sql','019_treatment_document_issuance.sql']) await db.exec(await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8'));
 await q("insert into treatment_records(id,organization_id,customer_id,treatment_name,amount,created_by) values($1,$2,$3,'Care',0,$4)",[treatment,org,customer,owner]);
 await user();
 await q("select * from mutate_document_template($1,$2,0,$3,'create',$4::jsonb)",[org,template,randomUUID(),JSON.stringify({name:'동의서',description:'',content:'{{customer.name}} / {{treatment.name}} / {{treatment.amount}}'})]);
 await q("select * from mutate_document_template($1,$2,1,$3,'publish','{}')",[org,template,randomUUID()]);
 let p,issued;const op=randomUUID();
 await check('preview exact contract and zero amount',async()=>{p=await preview();assert.deepEqual(Object.keys(p).sort(),['content','missing_fields','source_snapshot','template_id','template_version','title']);assert.equal(p.content,'홍길동 / Care / 0.00');assert.deepEqual(p.missing_fields,[]);});
 await check('issue and same-operation retry produce one immutable receipt',async()=>{issued=await issue(p,op);assert.equal(issued.content,p.content);assert.equal((await issue(p,op)).id,issued.id);assert.equal((await q('select * from issued_treatment_documents')).rows.length,1);await fails(()=>issue({...p,title:'tamper'},op),'P0001');});
 await check('all preview fields are compared and source changes reject stale review',async()=>{await fails(()=>issue({...p,extra:true}),'P0001');await db.exec('reset role');await q("update customers set phone='changed' where id=$1",[customer]);await user();await fails(()=>issue(p),'P0001');assert.equal((await issue(p,op)).id,issued.id);});
 await check('missing and unknown placeholders block issuance',async()=>{await content('{{customer.birth_date}} {{treatment.practitioner}} {{treatment.consultation_goal}} {{unknown.field}}');const m=await preview();assert.deepEqual(m.missing_fields,['customer.birth_date','treatment.practitioner','treatment.consultation_goal','unknown.field']);await fails(()=>issue(m),'22023');});
 await check('raw malformed tokens fail closed',async()=>{for(const text of ['{{customer.name','customer.name}}','{{}}','{{ customer.name }}','{{{customer.name}}}']){await content(text);const m=await preview();assert.ok(m.missing_fields.length);await fails(()=>issue(m),'22023');}});
 await check('values are substituted once, and only used values are required',async()=>{await db.exec('reset role');await q("update customers set name='{{treatment.name}}' where id=$1",[customer]);await user();await content('{{customer.name}}');const m=await preview();assert.equal(m.content,'{{treatment.name}}');assert.deepEqual(m.missing_fields,[]);await issue(m);});
 await check('null amount differs from zero',async()=>{await content('{{treatment.amount}}');await db.exec('reset role');await q('update treatment_records set amount=null where id=$1',[treatment]);await user();const m=await preview();assert.deepEqual(m.missing_fields,['treatment.amount']);await fails(()=>issue(m),'22023');});
 await check('empty and overlong templates/rendered values rejected',async()=>{for(const s of [' \n','x'.repeat(100001)]){await content(s);await fails(()=>preview(),'22023');}await content('{{customer.name}}'.repeat(5000));await db.exec('reset role');await q('update customers set name=$1 where id=$2',['x'.repeat(1000),customer]);await user();await fails(()=>preview(),'22023');});
 await check('member reads/previews but cannot issue or bypass render helper',async()=>{await content('static');await user(member);assert.equal((await preview()).content,'static');assert.ok((await q('select * from issued_treatment_documents')).rows.length);await fails(()=>issue(p,op),'42501');await fails(()=>q('select private.render_treatment_document($1,$2,$3,$4)',[org,customer,treatment,template]),'42501');});
 await check('tenant, wrong targets, anonymous and absent identity denied',async()=>{await user();await fails(()=>preview(randomUUID()),'P0002');await fails(()=>preview(customer,treatment,randomUUID()),'P0002');await fails(()=>preview(customer,treatment,template,other),'42501');await user(outsider);assert.equal((await q('select * from issued_treatment_documents')).rows.length,0);await fails(()=>preview(),'42501');await user(null);await fails(()=>preview(),'42501');await user(owner,'anon');await fails(()=>preview(),'42501');await user();});
 await check('all direct client writes denied',async()=>{for(const sql of ["update issued_treatment_documents set title='bad'",'delete from issued_treatment_documents','truncate issued_treatment_documents',"insert into issued_treatment_documents(id) values(gen_random_uuid())"]){await fails(()=>q(sql),'42501');}});
 await check('retirement prevents fresh issue but keeps issued content and replay',async()=>{const before=await preview();await q("select * from mutate_document_template($1,$2,2,$3,'retire','{}')",[org,template,randomUUID()]);await fails(()=>preview(),'22023');await fails(()=>issue(before),'22023');assert.equal((await issue(p,op)).id,issued.id);assert.equal((await one('select content from issued_treatment_documents where id=$1',[issued.id])).content,p.content);});
 await check('source deletes restricted',async()=>{await db.exec('reset role');for(const [table,id] of [['customers',customer],['treatment_records',treatment],['document_templates',template],['organizations',org],['auth.users',owner]])await assert.rejects(()=>q(`delete from ${table} where id=$1`,[id]),e=>['23001','23503'].includes(e.code));});
 console.log(`${checks} document issuance checks passed`);
}finally{await db.close();}
