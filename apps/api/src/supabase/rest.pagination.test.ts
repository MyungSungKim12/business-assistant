import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createRest } from './rest.js';

const config={APP_SUPABASE_URL:'https://test.invalid',APP_SUPABASE_PUBLISHABLE_KEY:'public',APP_FILE_BUCKET:'files',APP_API_PORT:8000};
const schema=z.object({id:z.string(),organization_id:z.string()});
const query={organization_id:'eq.org',order:'created_at.desc,id.desc'};
const row=(id:string)=>({id,organization_id:'org'});
const page=(rows:unknown[],range:string)=>new Response(JSON.stringify(rows),{headers:{'Content-Range':range}});

describe('complete PostgREST lists',()=>{
 it('서버 상한이 요청 크기보다 작아도 총건수까지 읽고 토큰·필터를 보존한다',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(page([row('a')],'0-0/3')).mockResolvedValueOnce(page([row('b')],'1-1/3')).mockResolvedValueOnce(page([row('c')],'2-2/3'));
  const result=await createRest(config,fetcher).selectAll('token','records',query,schema);
  expect(result.map(r=>r.id)).toEqual(['a','b','c']);
  expect(fetcher.mock.calls.map(([url])=>new URL(String(url)).searchParams.get('offset'))).toEqual(['0','1','2']);
  for(const [url,init] of fetcher.mock.calls){expect(new URL(String(url)).searchParams.get('organization_id')).toBe('eq.org');expect(init.headers).toMatchObject({Authorization:'Bearer token',Prefer:'count=exact'});}
 });
 it('총건수가 0인 빈 목록을 반환한다',async()=>{
  expect(await createRest(config,async()=>page([],'*/0')).selectAll('t','records',query,schema)).toEqual([]);
 });
 it('중간 페이지 오류를 부분 성공으로 반환하지 않는다',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(page([row('a')],'0-0/2')).mockResolvedValueOnce(new Response('{}',{status:503}));
  await expect(createRest(config,fetcher).selectAll('t','records',query,schema)).rejects.toMatchObject({status:503});
 });
 it.each([
  {name:'count 누락',response:()=>new Response(JSON.stringify([row('a')]))},
  {name:'미확정 count',response:()=>page([row('a')],'0-0/*')},
  {name:'잘못된 시작',response:()=>page([row('a')],'1-1/2')},
  {name:'길이 불일치',response:()=>page([row('a')],'0-1/2')},
  {name:'과도한 총건수',response:()=>page([row('a')],'0-0/20001')},
  {name:'진전 없는 빈 페이지',response:()=>page([],'*/2')},
 ])('$name 는 성공 처리하지 않는다',async({response})=>{
  await expect(createRest(config,async()=>response()).selectAll('t','records',query,schema)).rejects.toMatchObject({status:503});
 });
 it.each([{range:'1-1/3',id:'b'},{range:'1-1/2',id:'a'}])('건수 변경·중복 ID를 거절한다',async({range,id})=>{
  const fetcher=vi.fn().mockResolvedValueOnce(page([row('a')],'0-0/2')).mockResolvedValueOnce(page([row(id)],range));
  await expect(createRest(config,fetcher).selectAll('t','records',query,schema)).rejects.toMatchObject({status:503});
 });
 it('페이지 수 상한을 넘으면 무한 조회 대신 실패한다',async()=>{
  let offset=0;
  const fetcher=vi.fn(async()=>page([row(String(offset))],`${offset}-${offset++}/101`));
  await expect(createRest(config,fetcher).selectAll('t','records',query,schema)).rejects.toMatchObject({status:503});
  expect(fetcher).toHaveBeenCalledTimes(100);
 });
 it('조회 시간 제한을 넘으면 다음 페이지를 요청하지 않는다',async()=>{
  const clock=vi.spyOn(Date,'now').mockReturnValueOnce(0).mockReturnValue(30001);
  const fetcher=vi.fn();
  try{await expect(createRest(config,fetcher).selectAll('t','records',query,schema)).rejects.toMatchObject({status:503});expect(fetcher).not.toHaveBeenCalled();}finally{clock.mockRestore();}
 });
});
