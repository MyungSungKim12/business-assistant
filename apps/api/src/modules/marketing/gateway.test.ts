import {expect,it} from 'vitest';
import {createMarketingGateway} from './gateway.js';
import {ORG,OTHER_ORG,testConfig,fakeFetch} from '../catalog/testkit.js';
const blank={organization_id:ORG,templates:[],messages:[],provider_ready:false};
it('calls the organization scoped RPC using the user token and rejects a different organization',async()=>{
 const ok=fakeFetch(call=>({body:call.url.pathname.endsWith('get_organization_message_workspace')?blank:{}}));
 await expect(createMarketingGateway(testConfig,ok.fetcher).workspace('user-token',ORG)).resolves.toEqual(blank);
 expect(ok.calls[0]?.body).toEqual({p_organization_id:ORG});expect(ok.calls[0]?.headers.Authorization).toBe('Bearer user-token');
 const wrong=fakeFetch(()=>({body:{...blank,organization_id:OTHER_ORG}}));
 await expect(createMarketingGateway(testConfig,wrong.fetcher).workspace('user-token',ORG)).rejects.toMatchObject({status:503});
});
