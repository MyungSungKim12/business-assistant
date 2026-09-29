import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const org=randomUUID(), other=randomUUID(), owner=randomUUID(), member=randomUUID(), outsider=randomUUID(), admin=randomUUID();
const customer=randomUUID(), treatment=randomUUID(), template=randomUUID();
const q=(s,p=[])=>db.query(s,p), one=async(s,p)=>(await q(s,p)).rows[0];
let checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log(`PASS ${name}`);};
const fails=(fn,code)=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
async function user(id=owner,role='authenticated'){await db.exec(`reset role; set role ${role}`);await q("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);}
const preview=async(c=customer,t=treatment,tp=template,o=org)=>(await one('select public.preview_treatment_document($1,$2,$3,$4) as data',[o,c,t,tp])).data;
const issue=(p,op=randomUUID(),tp=template)=>one('select * from public.issue_treatment_document($1,$2,$3,$4,$5,$6::jsonb)',[org,customer,treatment,tp,op,JSON.stringify(p)]);
try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
 grant usage on schema auth,private,public to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table memberships(organization_id uuid,user_id uuid,role text);
 create table customers(id uuid primary key,organization_id uuid not null,name text,phone text,updated_at timestamptz default now());
 create function private.has_organization_role(target uuid,roles text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=target and user_id=auth.uid() and role=any(roles))$$;`);
 await q('insert into auth.users values($1),($2),($3),($4)',[owner,member,outsider,admin]);
 await q('insert into organizations values($1),($2)',[org,other]);
 await q("insert into memberships values($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[org,owner,member,other,outsider]);
 await q("insert into memberships values($1,$2,'admin')",[org,admin]);
 await q("insert into customers(id,organization_id,name,phone) values($1,$2,'홍길동','01012345678')",[customer,org]);
 for(const file of ['007_documents.sql','014_customer_records.sql','016_treatment_lifecycle.sql','017_treatment_consultation.sql','018_document_template_versions.sql','019_treatment_document_issuance.sql','020_document_consent.sql','021_treatment_sale_drafts.sql']) await db.exec(await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8'));
 await q("insert into treatment_records(id,organization_id,customer_id,treatment_name,amount,created_by) values($1,$2,$3,'Care',0,$4)",[treatment,org,customer,owner]);
 await user();
 await q("select * from mutate_document_template($1,$2,0,$3,'create',$4::jsonb)",[org,template,randomUUID(),JSON.stringify({name:'동의서',description:'',content:'{{customer.name}} / {{treatment.name}} / {{treatment.amount}}'})]);
 await q("select * from mutate_document_template($1,$2,1,$3,'publish','{}')",[org,template,randomUUID()]);
 const issued=await issue(await preview());
 const values={description:'Actual care',amount:'0',consent_document_id:null,exception_reason:'서명 미확인 예외',partial_reason:''};
 const salePreview=async(v=values,t=treatment,c=customer,o=org)=>(await one('select preview_treatment_sale_draft($1,$2,$3,$4::jsonb) as data',[o,c,t,JSON.stringify(v)])).data;
 const create=(p,op=randomUUID(),confirmed=true,t=treatment,c=customer,o=org)=>one('select * from create_treatment_sale_draft($1,$2,$3,$4,$5::jsonb,$6)',[o,c,t,op,JSON.stringify(p),confirmed]);
 const source=async(sql,p=[])=>{await db.exec('reset role');await q(sql,p);await user();};
 const event=(action,v,revision)=>one('select * from record_treatment_document_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[org,customer,treatment,issued.id,revision,randomUUID(),action,JSON.stringify(v)]);
 await check('only completed/cancelled sources',async()=>{
  for(const status of ['draft','in_progress','legacy']){await source('update treatment_records set status=$1 where id=$2',[status,treatment]);await fails(()=>salePreview(),'22023');}
  await source("update treatment_records set status='completed' where id=$1",[treatment]);
 });
 await check('strict exact values and decimal strings',async()=>{
  for(const v of [null,[],{}, {...values,extra:1},...['description','amount','consent_document_id','exception_reason','partial_reason'].map(k=>Object.fromEntries(Object.entries(values).filter(([key])=>key!==k))),
   ...[null,0,-1,'-1','+1','1e2','1.001','1000000000000','01',' 0','0 ','NaN','Infinity',''].map(amount=>({...values,amount})),
   ...[null,1,'',' \n','x'.repeat(201)].map(description=>({...values,description})),
   ...[null,1,'x'.repeat(2001)].map(exception_reason=>({...values,exception_reason})),
   ...[null,1,'x'.repeat(2001)].map(partial_reason=>({...values,partial_reason})),
   ...[1,'','bad',{},[]].map(consent_document_id=>({...values,consent_document_id}))])await fails(()=>salePreview(v),'22023');
  assert.equal((await salePreview({...values,amount:'999999999999.99'})).total_amount,'999999999999.99');
 });
 await check('zero preview is deterministic, source-rich, and quantity one',async()=>{
  const p=await salePreview();assert.deepEqual(await salePreview(),p);assert.deepEqual(Object.keys(p).sort(),['consent_status','line','source_snapshot','total_amount','values','warnings']);
  assert.equal(p.total_amount,'0.00');assert.equal(p.line.unit_price,'0.00');assert.equal(p.line.line_total,'0.00');assert.equal(p.line.quantity,1);assert.equal(p.source_snapshot.customer.name,'홍길동');assert.equal(p.source_snapshot.treatment.version,1);assert.equal(p.consent_status,'not_linked');assert.deepEqual(p.values,values);assert.equal(p.source_snapshot.consent.revision,0);
 });
 await check('cancelled requires actual values and partial reason',async()=>{
  await source("update treatment_records set status='cancelled' where id=$1",[treatment]);await fails(()=>salePreview(),'22023');
  const p=await salePreview({...values,partial_reason:'일부 제공',description:'부분 실제 시술',amount:'1200.5'});assert.equal(p.total_amount,'1200.50');assert.equal(p.source_snapshot.partial_reason,'일부 제공');
  await source("update treatment_records set status='completed' where id=$1",[treatment]);
 });
 await check('scope, missing source, and explicit consent exceptions',async()=>{
  await fails(()=>salePreview(values,randomUUID()),'P0002');await fails(()=>salePreview(values,treatment,randomUUID()),'P0002');
  await fails(()=>salePreview({...values,consent_document_id:randomUUID()}),'P0002');await fails(()=>salePreview({...values,exception_reason:''}),'22023');
  const p=await salePreview({...values,consent_document_id:issued.id});assert.equal(p.consent_status,'unsigned');assert.equal(p.source_snapshot.consent.template_version,1);assert.match(p.source_snapshot.consent.content_hash,/^[a-f0-9]{64}$/);
  await fails(()=>salePreview({...values,consent_document_id:issued.id,exception_reason:' '}),'22023');
 });
 let signedPreview;
 await check('sign status and revision derive from evidence; stale consent rejected',async()=>{
  const stale=await salePreview({...values,consent_document_id:issued.id});
  await event('sign',{signer_name:'홍길동',strokes:[[[0,0],[1,1]]],confirmed:true},0);
  await fails(()=>create(stale),'P0001');signedPreview=await salePreview({...values,consent_document_id:issued.id,exception_reason:''});assert.equal(signedPreview.consent_status,'signed');assert.equal(signedPreview.source_snapshot.consent.revision,1);
  await event('revoke',{reason:'철회',confirmed:true},1);
  await fails(()=>create(signedPreview),'22023');const p=await salePreview({...values,consent_document_id:issued.id});assert.equal(p.consent_status,'revoked');assert.equal(p.source_snapshot.consent.revision,2);
 });
 await check('confirmation, exact review and source changes guarded',async()=>{
  const p=await salePreview();for(const flag of [false,null])await fails(()=>create(p,randomUUID(),flag),'22023');
  await fails(()=>create({...p,total_amount:'100.00'}),'P0001');await fails(()=>create({...p,extra:true}),'P0001');
  await source("update customers set name='변경 고객' where id=$1",[customer]);await fails(()=>create(p),'P0001');
  const fresh=await salePreview();await source('update treatment_records set version=version+1 where id=$1',[treatment]);await fails(()=>create(fresh),'P0001');
 });
 const reviewed=await salePreview(),op=randomUUID();let receipt;
 await check('immutable draft creation has no source/counter side effects',async()=>{
  await db.exec('reset role');const before=await one('select to_jsonb(t) as t,(select to_jsonb(c) from customers c where id=$2) as c,(select count(*)::int from treatment_record_events) as events from treatment_records t where id=$1',[treatment,customer]);await user();
  receipt=await create(reviewed,op);assert.equal(receipt.status,'draft');assert.equal(Number(receipt.amount),0);assert.equal(receipt.created_by,owner);assert.deepEqual(receipt.source_snapshot,reviewed.source_snapshot);
  await db.exec('reset role');assert.deepEqual(await one('select to_jsonb(t) as t,(select to_jsonb(c) from customers c where id=$2) as c,(select count(*)::int from treatment_record_events) as events from treatment_records t where id=$1',[treatment,customer]),before);await user();
 });
 await check('same operation exact replay survives source changes; new operation conflicts',async()=>{
  await source("update treatment_records set version=version+1,treatment_name='Changed' where id=$1",[treatment]);
  assert.equal((await create(reviewed,op)).id,receipt.id);await fails(async()=>create(await salePreview()),'P0001');
  await fails(()=>create({...reviewed,total_amount:'1.00'},op),'P0001');await fails(()=>create(reviewed,op,true,randomUUID()),'P0001');
  await user(admin);await fails(()=>create(reviewed,op),'P0001');await user();
 });
 await check('membership RLS, member read/preview, manager creation, anonymous blocked',async()=>{
  await user(member);assert.equal((await q('select * from treatment_sale_drafts')).rows.length,1);await salePreview();await fails(()=>create(reviewed,op),'42501');
  await user(outsider);assert.equal((await q('select * from treatment_sale_drafts')).rows.length,0);await fails(()=>salePreview(),'42501');await fails(()=>create(reviewed,op),'42501');
  await user(null);await fails(()=>salePreview(),'42501');await user(owner,'anon');await fails(()=>salePreview(),'42501');await user();
 });
 await check('direct mutation and private helper denied; immutable even to SQL owner',async()=>{
  const mutations=["update treatment_sale_drafts set amount=1",'delete from treatment_sale_drafts','truncate treatment_sale_drafts'];
  for(const sql of [...mutations,'insert into treatment_sale_drafts(id) values(gen_random_uuid())'])await fails(()=>q(sql),'42501');
  await fails(()=>q('select private.render_treatment_sale_draft($1,$2,$3,$4::jsonb)',[org,customer,treatment,JSON.stringify(values)]),'42501');
  await db.exec('reset role');for(const sql of mutations)await fails(()=>q(sql),'42501');await user();
  assert.equal((await one('select count(*)::int as n from treatment_sale_drafts')).n,1);
 });
 await check('admin creates cancelled partial draft; foreign issued document cannot be linked',async()=>{
  const cancelled=randomUUID();
  await source("insert into treatment_records(id,organization_id,customer_id,treatment_name,amount,created_by,status) values($1,$2,$3,'Cancelled planned care',9999,$4,'cancelled')",[cancelled,org,customer,owner]);
  const actual={...values,description:'실제 일부 제공',amount:'15.25',partial_reason:'중단 후 실제 제공분'};
  await fails(()=>salePreview({...actual,consent_document_id:issued.id},cancelled),'P0002');
  const p=await salePreview(actual,cancelled);await user(admin);
  const row=await create(p,randomUUID(),true,cancelled);assert.equal(row.created_by,admin);assert.equal(row.description,actual.description);assert.equal(row.amount,'15.25');assert.equal(row.source_snapshot.treatment.status,'cancelled');await user();
 });
 console.log(`${checks} treatment sale draft checks passed (PGlite serial execution; multi-session locking requires PostgreSQL)`);
}finally{await db.close();}
