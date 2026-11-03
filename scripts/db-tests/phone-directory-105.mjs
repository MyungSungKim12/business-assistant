import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PGlite} from '@electric-sql/pglite';
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
const org=randomUUID(),other=randomUUID(),alice=randomUUID(),outsider=randomUUID();
const ids=['10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000003'];
const q=(s,a=[])=>db.query(s,a),one=async(s,a=[])=>(await q(s,a)).rows[0];
const user=async(id=alice)=>{await db.exec('reset role;set role authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const reject=(fn,code)=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
try {
 await db.exec(`create role anon;create role authenticated;create schema private;create schema auth;
 create table organizations(id uuid primary key);create table memberships(organization_id uuid,user_id uuid,role text);
 create table subscriptions(organization_id uuid,plan_id uuid,status text,ends_at timestamptz);create table plan_features(plan_id uuid,feature_code text);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function private.has_organization_role(o uuid,r text[]) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.memberships where organization_id=o and user_id=auth.uid() and role=any(r))$$;
 create function private.call_phone(p text) returns text language sql immutable as $$select case when p ~ '^010[0-9]{8}$' then '+82'||substr(p,2) else null end$$;
 create table customers(id uuid primary key,organization_id uuid not null references organizations(id) on delete cascade,name text,phone text,status text,notes text);
 grant usage on schema public,private,auth to authenticated;`);
 await q('insert into organizations values($1),($2)',[org,other]);await q("insert into memberships values($1,$2,'member'),($3,$2,'member')",[org,alice,other]);
 await q("insert into subscriptions values($1,$1,'active',null),($2,$2,'active',null)",[org,other]);await q("insert into plan_features values($1,'crm.basic'),($2,'crm.basic')",[org,other]);
 for(const [i,id] of ids.entries())await q("insert into customers values($1,$2,$3,'01012345678','active','')",[id,org,'고객'+i]);
 const sql=await readFile(new URL('../../migrations/105_phone_directory_incremental.sql',import.meta.url),'utf8').catch(e=>e.code==='ENOENT'?'':Promise.reject(e));if(sql){await db.exec('begin;'+sql+';commit');await db.exec('begin;'+sql+';commit');}
 const key=Buffer.alloc(32,7);assert.equal((await one('select private.phone_directory_mac($1,$2) mac',['signed-payload',key])).mac,createHmac('sha256',key).update('signed-payload').digest('hex'));
 // Match the production customer's ON DELETE CASCADE. Deleting its parent must
 // neither recreate directory state nor write a tombstone for a vanished tenant.
 const erasedOrg=randomUUID(),erasedCustomer=randomUUID();
 await q('insert into organizations values($1)',[erasedOrg]);
 await q("insert into customers values($1,$2,'삭제 조직 고객','01012345678','active','')",[erasedCustomer,erasedOrg]);
 assert.equal(Number((await one('select count(*) n from phone_directory_live where organization_id=$1',[erasedOrg])).n),1);
 await q('delete from organizations where id=$1',[erasedOrg]);
 for(const table of ['customers','phone_directory_state','phone_directory_live','phone_directory_changes'])assert.equal(Number((await one(`select count(*) n from ${table} where organization_id=$1`,[erasedOrg])).n),0);
 assert.equal(Number((await one('select count(*) n from phone_directory_live where organization_id=$1',[org])).n),3);
 const rpc=async(cursor=null,o=org,limit=2)=>(await one('select public.phone_directory($1,$2,$3) data',[o,cursor,limit])).data;
 await user();let page=await rpc();assert.equal(page.mode,'snapshot');assert.equal(page.items.length,2);const bootstrap=page.next_cursor;assert.ok(bootstrap);
 // Mutations between keyset pages: rename before boundary, move/delete, new insert behind boundary.
 await db.exec('reset role');await q("update customers set name='AAA' where id=$1",[ids[2]]);await q('delete from customers where id=$1',[ids[0]]);
 const added='05000000-0000-4000-8000-000000000004';await q("insert into customers values($1,$2,'신규','01099998888','vip','')",[added,org]);
 await user();const items=new Map(page.items.map(r=>[r.customer_id,r]));let token=bootstrap;let final;
 for(let i=0;i<20;i++){page=await rpc(token);for(const r of page.items){if(r.operation==='delete')items.delete(r.customer_id);else items.set(r.customer_id,r);}token=page.next_cursor;if(!token){final=page;break;}}
 assert.ok(final?.cursor);assert.equal(items.size,3);assert.equal(items.has(ids[0]),false);assert.equal(items.get(ids[2]).name,'AAA');assert.ok(items.has(added));
 let checkpoint=final.cursor;assert.equal((await rpc(checkpoint)).items.length,0);
 await db.exec('reset role');const before=(await one('select revision from phone_directory_state where organization_id=$1',[org])).revision;
 await q("update customers set notes='메모' where id=$1",[ids[1]]);assert.equal((await one('select revision from phone_directory_state where organization_id=$1',[org])).revision,before);
 await q("update customers set status='archived' where id=$1",[ids[1]]);await q("update customers set phone='invalid' where id=$1",[ids[2]]);await user();
 page=await rpc(checkpoint);assert.deepEqual(page.items.map(r=>r.operation),['delete','delete']);while(page.next_cursor)page=await rpc(page.next_cursor);checkpoint=page.cursor;
 await db.exec('reset role');await q("update customers set status='vip' where id=$1",[ids[1]]);await q('update customers set organization_id=$1 where id=$2',[other,added]);await user();
 const changes=[];page=await rpc(checkpoint);changes.push(...page.items);while(page.next_cursor){page=await rpc(page.next_cursor);changes.push(...page.items);}assert.ok(changes.some(r=>r.customer_id===ids[1]&&r.operation==='upsert'));assert.ok(changes.some(r=>r.customer_id===added&&r.operation==='delete'));
 checkpoint=page.cursor;assert.equal((await rpc(null,other)).items[0].customer_id,added);
 if(process.argv.includes('--api')){
  const {createApp}=await import('../../apps/api/dist/app.js');const {createPhoneGateway}=await import('../../apps/api/dist/modules/phone/gateway.js');
  const fetcher=async(url,options)=>{assert.equal(new URL(url).pathname,'/rest/v1/rpc/phone_directory');assert.equal(options.headers.Authorization,'Bearer alice');const args=JSON.parse(options.body);try{return Response.json((await one('select public.phone_directory($1,$2,$3) data',[args.p_org,args.p_cursor,args.p_limit])).data);}catch(e){return Response.json({code:e.code},{status:e.code==='42501'?403:400});}};
  const app=createApp({phone:createPhoneGateway({APP_SUPABASE_URL:'https://db.invalid',APP_SUPABASE_PUBLISHABLE_KEY:'public'},fetcher),auth:{getUser:async()=>({userId:alice})},organizations:{requireAccess:async()=> 'member'},customers:{search:async()=>{throw Error('legacy list must not be called')}},activities:{}});
  const url=`/api/v1/organizations/${org}/mobile/phone-directory-sync`,headers={authorization:'Bearer alice'};
  let response=await app.inject({url:url+'?cursor='+encodeURIComponent(checkpoint),headers});assert.equal(response.statusCode,200);assert.equal(response.json().items.length,0);assert.equal(response.headers['cache-control'],'no-store');
  response=await app.inject({url:url+'?cursor='+encodeURIComponent(checkpoint.slice(0,-1)+'x'),headers});assert.equal(response.statusCode,422);await app.close();
  console.log('105 API PASS: real route/gateway/SQL contract, no-change checkpoint, JWT forwarding, cache prevention and tampered cursor 422.');
 }
 await reject(()=>rpc(checkpoint,other),'22023');await reject(()=>rpc(checkpoint.slice(0,-1)+'x'),'22023');await reject(()=>rpc('v1:future:99999'),'22023');await reject(()=>rpc(null,org,501),'22023');
 await db.exec('reset role');
 for(const [m,upper,boundary] of [['c',999999,'999999'],['d',1,'2'],['c',2,'1']]){
  const forged=(await one('select private.phone_directory_cursor($1,$2,$3,$4,secret) token from phone_directory_state where organization_id=$1',[org,m,upper,boundary])).token;
  await user();await reject(()=>rpc(forged),'22023');await db.exec('reset role');
 }
 await user();
 await reject(()=>q('select * from phone_directory_live'),'42501');await reject(()=>q('select private.cleanup_phone_directory($1,$2)',[org,100]),'42501');
 await user(outsider);await reject(()=>rpc(),'42501');await db.exec('reset role;set role anon');await reject(()=>rpc(),'42501');
 await db.exec('reset role');await q("delete from plan_features where plan_id=$1",[org]);await user();await reject(()=>rpc(),'42501');await db.exec('reset role');await q("insert into plan_features values($1,'crm.basic')",[org]);
 // Retention floor atomically advances with deletion; every older cursor explicitly resets.
 await q('select private.cleanup_phone_directory($1,$2)',[org,1]);await user();page=await rpc(final.cursor);assert.equal(page.reset_required,true);assert.equal(page.items.length,0);
 if(native){
  await db.exec('reset role');
  const a=native.getPgClient(),b=native.getPgClient(),c=native.getPgClient();peers.push(a,b,c);await Promise.all(peers.map(p=>p.connect()));
  const first=randomUUID(),second=randomUUID(),foreign=randomUUID();
  await a.query('begin');await a.query("insert into customers values($1,$2,'late A','01011112222','active','')",[first,org]);
  const revA=Number((await a.query('select revision from phone_directory_state where organization_id=$1',[org])).rows[0].revision);
  // B writes a different customer but blocks at the org revision lock until A commits.
  const waiting=b.query("insert into customers values($1,$2,'early B','01033334444','active','')",[second,org]);
  const bPid=(await c.query("select pid from pg_stat_activity where query like '%early B%' and wait_event_type='Lock' limit 1")).rows[0]?.pid;
  // Poll pg_locks instead of relying on a single scheduling/timing assertion.
  let blocked=Boolean(bPid);for(let i=0;i<100&&!blocked;i++) {await new Promise(r=>setTimeout(r,10));blocked=Number((await c.query("select count(*) n from pg_stat_activity where wait_event_type='Lock' and query like '%insert into customers%'")).rows[0].n)>0;}
  assert.ok(blocked,'same-org revision writer must wait for A commit');
  await c.query("insert into customers values($1,$2,'independent org','01055556666','active','')",[foreign,other]);
  assert.equal(Number((await c.query('select revision from phone_directory_state where organization_id=$1',[org])).rows[0].revision),revA-1);
  await a.query('commit');await waiting;
  const revisions=(await c.query('select customer_id,revision from phone_directory_changes where organization_id=$1 and customer_id=any($2::uuid[]) order by revision',[org,[first,second]])).rows;
  assert.deepEqual(revisions.map(r=>r.customer_id),[first,second]);assert.equal(Number(revisions[1].revision),revA+1);
  // Rollback never publishes/consumes a revision; no low-revision late-commit hole.
  await a.query('begin');await a.query("update customers set name='rollback' where id=$1",[first]);await a.query('rollback');
  assert.equal(Number((await c.query('select revision from phone_directory_state where organization_id=$1',[org])).rows[0].revision),revA+1);
  console.log('105 native PostgreSQL PASS: separate connections block same-org revisions until commit, other org commits independently, rollback leaves no revision hole.');
 }
 console.log('105 PASS: snapshot keyset + concurrent insert/rename/delete, duplicate phones, tombstones/status/invalid/org moves, no-op notes, signed tenant cursors, retention reset, JWT/feature/direct ACL and reapply.');
}catch(e){console.error('105 FAIL:',e.message,e.code??'');process.exitCode=1;}finally{for(const p of peers){await p.query('rollback').catch(()=>{});await p.end();}await db.close();}

