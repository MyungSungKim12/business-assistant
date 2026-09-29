import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const org = randomUUID(), other = randomUUID(), owner = randomUUID(), member = randomUUID();
const id = randomUUID(), legacy = randomUUID();
const q = (sql, args = []) => db.query(sql, args);
const one = async (sql, args) => (await q(sql, args)).rows[0];
const values = {name: '동의서', description: '설명', content: '첫 번째 본문'};
let checks = 0;
const check = async (name, fn) => { await fn(); console.log(`PASS ${name}`); checks++; };
const fails = (fn, code) => assert.rejects(fn, e => { assert.equal(e.code, code, e.message); return true; });
async function user(id) {
  await db.exec('reset role; set role authenticated');
  await q("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}
async function mutate(action, revision, data = {}, operation = randomUUID(), tenant = org, target = id) {
  return one('select * from public.mutate_document_template($1,$2,$3,$4,$5,$6::jsonb)',
    [tenant, target, revision, operation, action, JSON.stringify(data)]);
}
try {
  await db.exec(`create role anon; create role authenticated;
    create schema auth; create schema private;
    grant usage on schema public,auth,private to authenticated,anon;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table auth.users(id uuid primary key);
    create table organizations(id uuid primary key);
    create table memberships(organization_id uuid,user_id uuid,role text);
    create function private.has_organization_role(target uuid, roles text[]) returns boolean
    language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.memberships where organization_id=target
        and user_id=auth.uid() and role=any(roles)) $$;`);
  await q('insert into auth.users values ($1),($2)', [owner,member]);
  await q('insert into organizations values ($1),($2)', [org,other]);
  await q("insert into memberships values ($1,$2,'owner'),($1,$3,'member')", [org,owner,member]);
  await db.exec(await readFile(new URL('../../migrations/007_documents.sql', import.meta.url),'utf8'));
  await db.exec('grant select,insert,update on document_templates,documents to authenticated');
  await q("insert into document_templates(id,organization_id,name,created_by) values ($1,$2,'Legacy',$3)",[legacy,org,owner]);
  await db.exec(await readFile(new URL('../../migrations/018_document_template_versions.sql',import.meta.url),'utf8'));
  await user(owner);
  await check('legacy templates are not silently published',async()=> {
    assert.equal((await one('select * from document_templates where id=$1',[legacy])).status,'draft');
  });
  let row;
  const createOp = randomUUID();
  await check('create and lost-response retry create exactly one draft',async()=> {
    row = await mutate('create',0,values,createOp);
    assert.equal(row.status,'draft'); assert.equal(row.version,1); assert.equal(row.revision,1);
    assert.equal((await mutate('create',0,values,createOp)).id,id);
    await fails(()=>mutate('create',0,{...values,name:'Changed'},createOp),'P0001');
  });
  await check('publish stores immutable snapshot and prevents edits',async()=> {
    await db.exec(`reset role;
      create function private.fail_template_receipt() returns trigger language plpgsql as $$
      begin raise exception 'Injected receipt failure' using errcode='23514'; end $$;
      create trigger fail_receipt before insert on private.document_template_operations
      for each row execute function private.fail_template_receipt();`);
    await user(owner);
    await fails(()=>mutate('publish',row.revision),'23514');
    assert.equal((await one('select status from document_templates where id=$1',[id])).status,'draft');
    assert.equal((await q('select * from document_template_versions where template_id=$1',[id])).rows.length,0);
    await db.exec('reset role; drop trigger fail_receipt on private.document_template_operations; drop function private.fail_template_receipt()');
    await user(owner);
    row=await mutate('publish',row.revision);
    assert.equal(row.status,'published');
    const snapshot=await one('select * from document_template_versions where template_id=$1',[id]);
    assert.equal(snapshot.content,values.content); assert.equal(snapshot.published_by,owner);
    assert.ok(snapshot.published_at);
    await fails(()=>mutate('save',row.revision,values),'P0001');
    await fails(()=>q("update document_template_versions set content='bad' where template_id=$1",[id]),'42501');
    await fails(()=>q('delete from document_template_versions where template_id=$1',[id]),'42501');
    await fails(()=>q("update document_templates set content='bad' where id=$1",[id]),'42501');
  });
  await check('new draft preserves prior publication and old document content',async()=> {
    await q("insert into documents(organization_id,template_id,title,content,created_by) values ($1,$2,'Issued','Original copy',$3)",[org,id,owner]);
    row=await mutate('revise',row.revision);
    assert.equal(row.version,2); assert.equal(row.status,'draft');
    await fails(()=>mutate('save',row.revision-1,values),'P0001');
    row=await mutate('save',row.revision,{...values,content:'Second'});
    row=await mutate('publish',row.revision);
    const versions=(await q('select * from document_template_versions where template_id=$1 order by version',[id])).rows;
    assert.deepEqual(versions.map(x=>x.content),[values.content,'Second']);
    assert.equal((await one('select content from documents')).content,'Original copy');
  });
  await check('retirement preserves versions and blocks further changes',async()=> {
    const op=randomUUID(), rev=row.revision;
    row=await mutate('retire',rev,{},op);
    assert.equal(row.status,'retired'); assert.equal(row.is_archived,true);
    assert.equal((await mutate('retire',rev,{},op)).revision,row.revision);
    await fails(()=>mutate('revise',row.revision),'P0001');
    assert.equal((await q('select * from document_template_versions where template_id=$1',[id])).rows.length,2);
    assert.equal((await mutate('create',0,values,createOp)).status,'retired');
  });
  await check('strict input errors roll back without creating records',async()=> {
    for (const data of [{...values,extra:true},{...values,name:''},{...values,content:null}]) {
      await fails(()=>mutate('create',0,data,randomUUID(),org,randomUUID()),'22023');
    }
    const blank=randomUUID();
    const draft=await mutate('create',0,{...values,content:' \n'},randomUUID(),org,blank);
    await fails(()=>mutate('publish',draft.revision,{},randomUUID(),org,blank),'22023');
  });
  await check('members can read but cannot mutate or replay owner operations',async()=> {
    await user(member);
    assert.equal((await q('select * from document_template_versions where template_id=$1',[id])).rows.length,2);
    await fails(()=>mutate('create',0,values,createOp),'42501');
    await fails(()=>q("insert into document_templates(organization_id,name,created_by) values ($1,'bad',$2)",[org,member]),'42501');
  });
  await check('other organization and anonymous access denied',async()=> {
    await user(owner);
    await fails(()=>mutate('save',row.revision,values,randomUUID(),other),'42501');
    await db.exec('reset role; set role anon');
    await fails(()=>mutate('create',0,values),'42501');
    await fails(()=>q('select * from document_template_versions'),'42501');
  });
  await check('tenant-scoped row lookup and history RLS hide other organizations',async()=> {
    await db.exec('reset role');
    await q("insert into memberships values ($1,$2,'owner')",[other,member]);
    await user(member);
    const foreignId=randomUUID();
    const foreign=await mutate('create',0,values,randomUUID(),other,foreignId);
    await mutate('publish',foreign.revision,{},randomUUID(),other,foreignId);
    await user(owner);
    assert.equal((await q('select * from document_template_versions where template_id=$1',[foreignId])).rows.length,0);
    assert.equal((await q('select * from document_templates where id=$1',[foreignId])).rows.length,0);
    await fails(()=>mutate('save',1,values,randomUUID(),org,foreignId),'P0002');
    await fails(()=>q('truncate document_templates cascade'),'42501');
  });
  await check('draft can be retired without inventing a published version',async()=> {
    const target=randomUUID();
    const draft=await mutate('create',0,values,randomUUID(),org,target);
    await mutate('retire',draft.revision,{},randomUUID(),org,target);
    assert.equal((await q('select * from document_template_versions where template_id=$1',[target])).rows.length,0);
  });
  console.log(`${checks} document version checks passed`);
} finally { await db.close(); }
