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
const addRecurring=(by,name,extra={})=>one(`insert into finance_recurring_expenses(organization_id,name,amount,category,counterparty,memo,day_of_month,created_by)
 values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[extra.org??org,name,extra.amount??'1200000.00',extra.category??'임대료',extra.counterparty??'건물주',extra.memo??'',extra.day??25,by]);
const generate=async(month,who=org)=>(await one('select generate_finance_recurring_expenses($1,$2) data',[who,month])).data;
const txns=async(month)=>(await q("select * from finance_transactions where organization_id=$1 and to_char(transaction_date,'YYYY-MM')=$2 order by transaction_date,memo",[org,month])).rows;
const currentMonth=()=>{const kst=new Date(Date.now()+9*3600000);return kst.toISOString().slice(0,7);};
const shiftMonth=(base,delta)=>{const [y,m]=base.split('-').map(Number);const d=new Date(Date.UTC(y,m-1+delta,1));return d.toISOString().slice(0,7);};

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
 await db.exec(await file('008_finance_transactions.sql'));
 await db.exec(await file('042_sales_search_finance_month_close.sql'));
 await db.exec('grant select,insert,update,delete on finance_transactions to authenticated;');
 await db.exec(await file('052_finance_recurring_expenses.sql'));
 await db.exec(await file('052_finance_recurring_expenses.sql')); // 멱등

 // --- owner/admin만 반복 지출을 만들고, 구성원은 읽기만 ---
 await asUser(owner);
 const rent=await addRecurring(owner,'월세');
 assert.equal(rent.version,1);assert.equal(rent.is_active,true);
 await asUser(admin);
 const phone=await addRecurring(admin,'통신비',{amount:'55000',category:'통신비',day:31,counterparty:'통신사',memo:'인터넷'});
 await fail(()=>addRecurring(admin,'  월세  '),'23505');
 await asUser(member);
 assert.equal((await q('select * from finance_recurring_expenses where organization_id=$1',[org])).rows.length,2);
 await fail(()=>addRecurring(member,'구성원 작성'),'42501');
 assert.equal((await q("update finance_recurring_expenses set amount=1 where id=$1",[rent.id])).affectedRows,0);
 await fail(()=>generate(`${currentMonth()}-01`),'42501');

 // --- 입력 한도 ---
 await asUser(owner);
 await fail(()=>addRecurring(owner,'금액 0',{amount:'0'}),'23514');
 await fail(()=>addRecurring(owner,'날짜 0',{day:0}),'23514');
 await fail(()=>addRecurring(owner,'날짜 32',{day:32}),'23514');
 await fail(()=>addRecurring(owner,'분류 없음',{category:'  '}),'23514');
 await fail(()=>addRecurring(owner,'가'.repeat(121)),'23514');

 // --- 한 달치 등록: 날짜 보정(31일 → 말일), 거래 내용, 중복 방지 ---
 const month=shiftMonth(currentMonth(),-1);
 const first=await generate(`${month}-15`);
 assert.equal(first.created,2);assert.equal(first.skipped,0);
 assert.equal(first.month,`${month}-01`);
 const rows=await txns(month);
 assert.equal(rows.length,2);
 const rentTx=rows.find(r=>r.memo.startsWith('반복 지출: 월세'));
 const phoneTx=rows.find(r=>r.memo.startsWith('반복 지출: 통신비'));
 assert.equal(rentTx.transaction_type,'expense');assert.equal(Number(rentTx.amount),1200000);assert.equal(rentTx.category,'임대료');
 assert.equal(rentTx.counterparty,'건물주');assert.equal(rentTx.created_by,owner);
 assert.equal(String(rentTx.transaction_date.toISOString?.().slice(0,10)??rentTx.transaction_date).slice(0,10),`${month}-25`);
 const lastDay=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).getUTCDate();
 assert.equal(String(phoneTx.transaction_date.toISOString?.().slice(0,10)??phoneTx.transaction_date).slice(0,10),`${month}-${String(lastDay).padStart(2,'0')}`,'31일은 그 달의 마지막 날로 맞춘다');
 assert.equal(phoneTx.memo,'반복 지출: 통신비 — 인터넷');
 const again=await generate(`${month}-01`);
 assert.equal(again.created,0);assert.equal(again.skipped,2);
 assert.equal((await txns(month)).length,2,'다시 눌러도 중복 등록되지 않는다');
 assert.equal((await q('select * from finance_recurring_runs where organization_id=$1',[org])).rows.length,2);

 // --- 새 템플릿·비활성: 이미 등록한 달은 건드리지 않고, 새로 생긴 것만 추가한다 ---
 const insurance=await addRecurring(owner,'보험료',{amount:'80000',category:'보험',day:10});
 const third=await generate(`${month}-01`);
 assert.equal(third.created,1);assert.equal(third.skipped,2);
 await q('update finance_recurring_expenses set is_active=false where id=$1',[phone.id]);
 const next=shiftMonth(month,1);
 const forNext=await generate(`${next}-01`);
 assert.equal(forNext.created,2,'비활성 항목은 등록하지 않는다');
 assert.deepEqual((await txns(next)).map(r=>r.memo.split(' ')[2]).sort(),['보험료','월세'].sort());

 // --- 템플릿을 고쳐도 이미 등록한 거래는 바뀌지 않는다 ---
 const updated=await one('update finance_recurring_expenses set amount=1300000 where id=$1 and version=$2 returning *',[rent.id,1]);
 assert.equal(updated.version,2);
 assert.equal((await q('update finance_recurring_expenses set amount=1 where id=$1 and version=$2 returning *',[rent.id,1])).rows.length,0,'오래된 버전은 수정되지 않는다');
 assert.equal(Number((await txns(month)).find(r=>r.memo.startsWith('반복 지출: 월세')).amount),1200000);

 // --- 마감된 달에는 등록하지 않는다 ---
 const closedMonth=shiftMonth(month,-1);
 await one('select close_finance_month($1,$2,$3)',[org,`${closedMonth}-01`,'테스트 마감']);
 await fail(()=>generate(`${closedMonth}-01`),'P0001');
 assert.equal((await txns(closedMonth)).length,0);
 await one('select reopen_finance_month($1,$2,$3)',[org,`${closedMonth}-01`,'재오픈']);
 const reopened=await generate(`${closedMonth}-01`);
 assert.equal(reopened.created,2,'재오픈하면 다시 등록할 수 있다(활성 항목만)');
 assert.equal((await generate(`${closedMonth}-01`)).created,0);

 // --- 너무 먼 미래, 입력 오류 ---
 await fail(()=>generate(`${shiftMonth(currentMonth(),2)}-01`),'22023');
 await fail(()=>one('select generate_finance_recurring_expenses($1,$2)',[org,null]),'22023');

 // --- 다른 조직 격리 ---
 await asUser(outsider);
 assert.equal((await q('select * from finance_recurring_expenses where organization_id=$1',[org])).rows.length,0);
 assert.equal((await q('select * from finance_recurring_runs where organization_id=$1',[org])).rows.length,0);
 await fail(()=>generate(`${month}-01`,org),'42501');
 await fail(()=>addRecurring(outsider,'침입',{org}),'42501');

 // --- 삭제: 템플릿을 지워도 등록한 거래는 남는다 ---
 await asUser(admin);
 assert.equal((await q('delete from finance_recurring_expenses where id=$1',[insurance.id])).affectedRows,1);
 assert.ok((await txns(month)).some(r=>r.memo.startsWith('반복 지출: 보험료')));
 console.log('PASS ops-052: recurring expenses — roles, limits, day clamp, no duplicate runs, month close guard, tenants');
} finally {
 await db.close();
}
