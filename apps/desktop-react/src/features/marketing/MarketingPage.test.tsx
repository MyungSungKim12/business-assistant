import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import type {ApiClient} from '../../api/client';
import {MarketingPage} from './MarketingPage';
const ORG='a9cc39fd-8e8c-4df8-a623-1f23a3a936bd',CUSTOMER='b9cc39fd-8e8c-4df8-a623-1f23a3a936bd',TEMPLATE='c9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const template={id:TEMPLATE,organization_id:ORG,name:'예약 확인',channel:'sms' as const,purpose:'transactional' as const,body:'#{customer_name}님 예약 확인',version:1,is_active:true,created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:00:00Z'};
function client(){const call=vi.fn(async(method:string,path:string,_schema:unknown,body?:unknown):Promise<any>=>{
 if(method==='GET'&&path.endsWith('/marketing'))return{organization_id:ORG,templates:[template],messages:[],provider_ready:false};
 if(method==='GET'&&path.includes('/customers/search'))return{items:[{id:CUSTOMER,organization_id:ORG,name:'테스트 고객',phone:'01012345678',marketing_consent:true}],total:1,next_cursor:null};
 if(method==='POST'&&path.endsWith('/preview'))return{eligible:[{customer_id:CUSTOMER,name:'테스트 고객',phone_masked:'010****5678'}],excluded:[],template_version:1,provider_ready:false};
 if(method==='POST'&&path.endsWith('/enqueue'))return{created:1,excluded:[],messages:[{id:'d9cc39fd-8e8c-4df8-a623-1f23a3a936bd',customer_id:CUSTOMER,status:'queued',scheduled_at:'2026-11-03T00:00:00Z',attempt_count:0}],provider_ready:false};
 return{template};
 });return{call};}
it('keeps unconfigured delivery explicit while supporting search, consent preview and outbox enqueue',async()=>{
 const api=client();render(<MarketingPage api={api as unknown as ApiClient} organizationId={ORG} readOnly={false}/>);
 expect(await screen.findByText(/실제로 전송되지 않으며 성공\/전달로 표시되지 않습니다/)).toBeInTheDocument();
 fireEvent.change(screen.getByRole('textbox',{name:'고객 검색'}),{target:{value:'테스트'}});fireEvent.click(screen.getByRole('button',{name:'고객 검색'}));
 const customer=await screen.findByText('테스트 고객');fireEvent.click(customer.closest('label')!.querySelector('input')!);
 fireEvent.click(screen.getByRole('button',{name:'대상 미리보기'}));expect(await screen.findByText('포함 · 테스트 고객 · 010****5678')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'대기열에 등록'}));expect(await screen.findByText(/실제 전송되지는 않았습니다/)).toBeInTheDocument();
 await waitFor(()=>expect(api.call).toHaveBeenCalledWith('POST',`/organizations/${ORG}/marketing/enqueue`,expect.anything(),expect.objectContaining({template_id:TEMPLATE,customer_ids:[CUSTOMER]})));
});
