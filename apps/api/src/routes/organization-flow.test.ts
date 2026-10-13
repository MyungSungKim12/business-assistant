import { describe, it, expect } from 'vitest';
import { createApp } from '../app.js';
import { createOrganizationGateway } from '../supabase/organizations.js';

const org = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const user = 'b9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
const config = { APP_SUPABASE_URL:'https://example.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY:'public', APP_SUPABASE_SERVICE_KEY:'secret', APP_FILE_BUCKET:'business-files', APP_API_PORT:8000 };
function fixture(options: {invalid?:boolean; member?:boolean; outage?:boolean; subscription?:boolean} = {}) {
  const calls: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    expect(new Headers(init?.headers).get('apikey')).toBe('public');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access');
    if (options.outage) throw new Error('private provider diagnostic');
    if (url.pathname === '/auth/v1/user') return Response.json(options.invalid ? {} : { id:user }, {status: options.invalid ? 401:200});
    if (url.pathname.endsWith('organization_exists')) return Response.json(true);
    if (url.pathname.endsWith('memberships')) {
      expect(url.searchParams.get('user_id')).toBe('eq.'+user);
      return Response.json(options.member === false ? [] : [{role:'owner', organizations:{id:org,name:'매장',slug:'shop'}}]);
    }
    if (url.pathname.endsWith('subscriptions')) return Response.json(options.subscription === false ? [] : [{status:'active',ends_at:null,plans:{code:'pro',plan_features:[{feature_code:'crm.basic'}]}}]);
    throw new Error('Unexpected request: '+url.pathname);
  };
  const app = createApp({ organizations:createOrganizationGateway(config, fetcher) });
  return {app,calls};
}
describe('organization HTTP flow', () => {
  it('verifies the token and returns membership-scoped organizations', async () => {
    const {app} = fixture();
    const result = await app.inject({url:'/api/v1/organizations',headers:{authorization:'bearer access'}});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual([{id:org,name:'매장',slug:'shop',role:'owner'}]);
    await app.close();
  });
  it('rejects an invalid token before querying memberships', async () => {
    const {app,calls} = fixture({invalid:true});
    const result = await app.inject({url:'/api/v1/organizations',headers:{authorization:'Bearer access'}});
    expect(result.statusCode).toBe(401); expect(calls).toHaveLength(1);
    await app.close();
  });
  it('rejects another organization before querying subscriptions', async () => {
    const {app,calls} = fixture({member:false});
    const result = await app.inject({url:'/api/v1/organizations/'+org+'/entitlements',headers:{authorization:'Bearer access'}});
    expect(result.statusCode).toBe(403);
    expect(calls.some(url=>url.pathname.endsWith('subscriptions'))).toBe(false);
    await app.close();
  });
  it('returns active features in the existing client format', async () => {
    const {app} = fixture();
    const result = await app.inject({url:'/api/v1/organizations/'+org+'/entitlements',headers:{authorization:'Bearer access'}});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({organization_id:org,plan_code:'pro',features:['crm.basic']});
    await app.close();
  });
  it('returns no features without an active subscription', async () => {
    const {app} = fixture({subscription:false});
    const result = await app.inject({url:'/api/v1/organizations/'+org+'/entitlements',headers:{authorization:'Bearer access'}});
    expect(result.json()).toEqual({organization_id:org,plan_code:null,features:[]});
    await app.close();
  });
  it('reports provider outages as 503 without exposing diagnostics', async () => {
    const {app} = fixture({outage:true});
    const result = await app.inject({url:'/api/v1/organizations',headers:{authorization:'Bearer access'}});
    expect(result.statusCode).toBe(503); expect(result.body).not.toContain('private');
    await app.close();
  });
});

