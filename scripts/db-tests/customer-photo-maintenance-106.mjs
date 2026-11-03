// Isolated PostgreSQL contracts. No real storage objects or remote writes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
let db,native;const peers=[];
if(process.argv.includes('--postgres')){
 // Optional native engine lives outside the repository; never use a remote URL.
 const root=resolve(process.env.PHONE_DIRECTORY_PG_TOOLS||'');assert.ok(process.env.PHONE_DIRECTORY_PG_TOOLS,'Set PHONE_DIRECTORY_PG_TOOLS to an isolated tooling folder');
 const require=createRequire(join(root,'package.json'));const {default:EmbeddedPostgres}=await import(pathToFileURL(require.resolve('embedded-postgres')));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 native=new EmbeddedPostgres({databaseDir:join(root,'cluster-'+randomUUID()),user:'postgres',password:randomUUID(),port,persistent:true,autoRehydrateSymlinks:true,postgresFlags:['-h','127.0.0.1'],onLog:message=>{if(process.env.PHONE_DIRECTORY_PG_VERBOSE)console.log(message)},onError:message=>console.error(message)});
 await native.initialise();let stop=()=>native.stop();
 if(process.platform==='win32'){
  // pg_ctl drops the administrative token on Windows; direct postgres.exe refuses it.
  const platformRequire=createRequire(require.resolve('embedded-postgres'));const {pg_ctl}=await import(pathToFileURL(platformRequire.resolve('@embedded-postgres/windows-x64')));
  const ctl=(args)=>promisify(execFile)(pg_ctl,args,{windowsHide:true,timeout:30000});
  await ctl(['-D',native.options.databaseDir,'-l',join(native.options.databaseDir,'server.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);
  stop=()=>ctl(['-D',native.options.databaseDir,'-m','fast','-w','stop']);
 }else await native.start();
 const client=native.getPgClient();await client.connect();
 db={query:(s,a)=>client.query(s,a),exec:s=>client.query(s),close:async()=>{await client.end();await stop();}};
}else db=new PGlite();

const org=randomUUID(), other=randomUUID(), customer=randomUUID(), admin=randomUUID(),member=randomUUID(),outsider=randomUUID();
try {
 await db.exec(`create role anon; create role authenticated; create schema auth; create schema private; create schema storage;
 grant usage on schema public,private,auth,storage to authenticated,anon;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table customers(id uuid primary key,organization_id uuid,unique(id,organization_id));
 create table memberships(organization_id uuid,user_id uuid,role text);
 create table storage.buckets(id text primary key,public boolean);insert into storage.buckets values('business-files',false);
 create table storage.objects(bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function private.has_organization_role(o uuid,r text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=o and user_id=auth.uid() and role=any(r))$$;
 create function private.person_name(uuid) returns text language sql as $$select 'test'::text$$;`);
 for(const u of [admin,member,outsider])await db.query('insert into auth.users values($1)',[u]);
 for(const o of [org,other])await db.query('insert into organizations values($1)',[o]);
 await db.query('insert into customers values($1,$2)',[customer,org]);
 for(const [o,u,r] of [[org,admin,'admin'],[org,member,'member'],[other,outsider,'owner']])await db.query('insert into memberships values($1,$2,$3)',[o,u,r]);
 for(const f of ['022_customer_photos.sql','053_customer_photo_trash.sql','100_customer_photo_upload_completion.sql'])await db.exec(await readFile(new URL(`../../migrations/${f}`,import.meta.url),'utf8'));
 // PGlite has no pg_cron extension. Execute the exact migration body against a
 // functional cron catalogue stub; remote extension activation is a separate gate.
 await db.exec(`create schema cron;create table cron.job(jobid serial primary key,jobname text unique,schedule text,command text);
 create function cron.schedule(text,text,text) returns bigint language plpgsql as $$declare n bigint;begin
 insert into cron.job(jobname,schedule,command) values($1,$2,$3) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid into n;return n;end$$;
 create table private.retention_calls(kind text,n integer);
 create function private.cleanup_phone_inbox(integer) returns integer language plpgsql as $$begin insert into private.retention_calls values('inbox',$1);return 0;end$$;
 create table public.phone_directory_state(organization_id uuid primary key,min_revision bigint,revision bigint);
 create function private.cleanup_phone_directory(uuid,integer) returns integer language plpgsql as $$begin insert into private.retention_calls values('directory',$2);return 0;end$$;`);
 const sql=await readFile(new URL('../../migrations/106_customer_photo_maintenance.sql',import.meta.url),'utf8');
 const localSql=sql.replace(/create extension if not exists pg_cron with schema pg_catalog;/i,'');
 await db.exec(localSql);await db.exec(localSql);
 assert.equal((await db.query('select count(*)::int n from cron.job')).rows[0].n,2,'repeat migration must not duplicate jobs');
 async function actor(u){await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[u]);}
 async function photo(age=0){await db.exec('reset role');const p={id:randomUUID(),path:randomUUID()};await db.query(`insert into customer_photos(id,organization_id,customer_id,uploaded_by,storage_path,original_name,content_type,size_bytes,created_at) values($1,$2,$3,$4,$5,'safe.png','image/png',4,now()-$6::interval)`,[p.id,org,customer,admin,p.path,age+' minutes']);return p;}
 async function object(p,size=4,mimetype='image/png'){await db.exec('reset role');await db.query(`insert into storage.objects values('business-files',$1,$2)`,[p.path,JSON.stringify({size,mimetype})]);}
 async function state(p){await db.exec('reset role');return(await db.query('select upload_state,is_archived,upload_failure_reason,upload_failed_at from customer_photos where id=$1',[p.id])).rows[0];}
 async function run(){await db.exec("reset role;select set_config('request.jwt.claim.sub','',false)");return(await db.query('select private.run_photo_upload_maintenance() result')).rows[0].result;}
 const valid=await photo();await object(valid);await run();assert.equal((await state(valid)).upload_state,'ready');
 const archived=await photo();await object(archived);await run();await db.query("update customer_photos set is_archived=true,archived_reason='deleted' where id=$1",[archived.id]);await run();assert.equal((await state(archived)).upload_state,'ready');assert.equal((await state(archived)).is_archived,true);
 // 250 fresh incomplete entries must not starve a later completed entry.
 for(let i=0;i<250;i++)await photo(20);
 const recovered=await photo(1);await object(recovered);await run();assert.equal((await state(recovered)).upload_state,'ready');
 const fresh=await photo(129.99),boundary=await photo(130),expired=await photo(131),wrongSize=await photo(131),wrongType=await photo(131),badNumber=await photo(131);
 await object(wrongSize,5);await object(wrongType,4,'text/html');await object(badNumber,'9'.repeat(100));
 // Use one transaction so now() remains exactly at the boundary throughout.
 await db.exec('begin');await db.query("update customer_photos set created_at=now()-interval '130 minutes' where id=$1",[boundary.id]);await run();
 assert.equal((await state(boundary)).upload_state,'pending');await db.exec('commit');
 assert.equal((await state(fresh)).upload_state,'pending');
 for(const [p,reason]of [[expired,'object_missing'],[wrongSize,'metadata_mismatch'],[wrongType,'metadata_mismatch'],[badNumber,'metadata_mismatch']]){const s=await state(p);assert.equal(s.upload_state,'failed');assert.equal(s.is_archived,true);assert.equal(s.upload_failure_reason,reason);assert.ok(s.upload_failed_at);}
 await run();assert.equal((await state(recovered)).upload_state,'ready');
 const more=[];for(let i=0;i<251;i++)more.push(await photo(132));
 assert.equal((await run()).processed,250);await db.exec('reset role');assert.equal((await db.query("select count(*)::int n from customer_photos where id=any($1::uuid[]) and upload_state='pending'",[more.map(p=>p.id)])).rows[0].n,1);await run();assert.equal((await state(more[250])).upload_state,'failed');
 for(const u of [admin,member,outsider,'']){await actor(u);await assert.rejects(db.query('select private.run_photo_upload_maintenance()'));await assert.rejects(db.query('select private.reconcile_customer_photo_uploads(null,null)'));}
 await actor(admin);const status=(await db.query('select public.customer_photo_upload_status($1,$2) result',[org,customer])).rows[0].result;
 assert.ok(status.items.some(x=>x.id===expired.id&&x.upload_failure_reason==='object_missing'));assert.equal(status.maintenance.state,'succeeded');assert.equal(status.limit,250);
 assert.ok(!JSON.stringify(status).includes('storage_path'));assert.ok(!JSON.stringify(status.maintenance).includes('processed'));
 for(const u of [member,outsider,'']){await actor(u);await assert.rejects(db.query('select public.customer_photo_upload_status($1,$2)',[org,customer]));}
 await actor(admin);await assert.rejects(db.query('select public.customer_photo_upload_status($1,$2)',[other,customer]));
 await assert.rejects(db.query('select public.reconcile_customer_photo_uploads(null,null)'));
 await db.exec('reset role;set role anon');await assert.rejects(db.query('select public.reconcile_customer_photo_uploads($1,$2)',[org,customer]));
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from storage.objects')).rows[0].n,6,'no storage object deletion');
 // Execute registered jobs with the same no-JWT context used by cron.
 for(const j of (await db.query('select command from cron.job')).rows)await db.exec(j.command);
 assert.equal((await db.query("select n from private.retention_calls where kind='inbox'")).rows[0].n,500);
 if(native){
  const a=native.getPgClient();peers.push(a);await a.connect();
  const locked=await photo();await object(locked);
  await a.query('begin');await a.query('select id from customer_photos where id=$1 for update',[locked.id]);
  await run();assert.equal((await state(locked)).upload_state,'pending','cron skips locked completion');
  await a.query("select set_config('request.jwt.claim.sub',$1,true)",[admin]);
  await a.query('select public.complete_customer_photo_upload($1,$2,$3)',[org,customer,locked.id]);await a.query('commit');
  await run();assert.equal((await state(locked)).upload_state,'ready');
  await a.query('begin;select pg_advisory_xact_lock(106,1)');
  assert.equal((await run()).state,'busy');await a.query('rollback');
  const broken=await photo();await object(broken);
  await db.exec(`create function private.test_slow_photo() returns trigger language plpgsql as $$begin perform pg_sleep(1);return new;end$$;
   create trigger zz_test_slow_photo before update on customer_photos for each row when(new.upload_state='ready') execute function private.test_slow_photo();`);
  await db.exec("set statement_timeout='100ms'");
  assert.equal((await run()).state,'failed');
  await db.exec("set statement_timeout=0");
  const diagnostic=(await db.query('select state,error_code from private.photo_upload_maintenance_status')).rows[0];assert.deepEqual(diagnostic,{state:'failed',error_code:'57014'});
  assert.equal((await state(broken)).upload_state,'pending','cancelled batch rolls back changes');
  await db.exec('drop trigger zz_test_slow_photo on customer_photos');await run();assert.equal((await state(broken)).upload_state,'ready');
  console.log('PASS native 106: concurrent completion/cron SKIP LOCKED, duplicate global job exclusion, statement timeout redacted failure and rollback/recovery');
 }
 console.log('PASS 106: JWT-free bounded recovery, fresh starvation, strict expiry boundary, size/MIME/malformed metadata, repeat/idempotence, no object deletion, role/org/anon ACL, manager redacted status, named cron/retention contracts');
} finally {for(const p of peers){await p.query('rollback').catch(()=>{});await p.end();}await db.close();}
