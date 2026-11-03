import {afterEach,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {auth,buildApp,fakeFetch,fakeOrganizations,ORG,OTHER_ORG,OP,testConfig} from '../catalog/testkit.js';
import {registerBookingPolicyRoutes} from './routes.js';
import {createBookingPolicyGateway} from './gateway.js';
const policy={enabled:false,timezone_name:'Asia/Seoul',minimum_notice_minutes:0,same_day_cutoff_time:null,hours:[],blocks:[]};
let app:FastifyInstance;afterEach(async()=>{await app?.close();});
function setup(role:'owner'|'member'|'outsider'='owner',body:unknown={...policy,organization_id:ORG,version:0},status=200,features=['task.basic']){
 const {fetcher,calls}=fakeFetch(()=>({body,status}));app=buildApp(a=>registerBookingPolicyRoutes(a,fakeOrganizations(role,features),createBookingPolicyGateway(testConfig,fetcher)));
 return {calls,send:(method:'GET'|'PUT',payload?:unknown)=>app.inject({method,url:`/api/v1/organizations/${ORG}/booking-policy`,headers:auth,payload:payload as never})};
}
it('members read and administrators save through tenant scoped RPCs',async()=>{
 const {send,calls}=setup();expect((await send('GET')).json()).toEqual({...policy,organization_id:ORG,version:0});
 expect((await send('PUT',{policy,expected_version:0,operation_id:OP})).statusCode).toBe(200);
 expect(calls[1].body).toEqual({p_organization_id:ORG,p_expected_version:0,p_operation_id:OP,p_policy:policy});
 const member=setup('member');expect((await member.send('GET')).statusCode).toBe(200);expect((await member.send('PUT',{policy,expected_version:0,operation_id:OP})).statusCode).toBe(403);
});
it('fails closed on foreign or missing policy responses, errors and access/validation denial',async()=>{
 for(const body of [null,{...policy,organization_id:OTHER_ORG,version:1}])expect((await setup('owner',body).send('GET')).statusCode).toBe(503);
 expect((await setup('owner',{},503).send('GET')).statusCode).toBe(503);
 expect((await setup('outsider').send('GET')).statusCode).toBe(403);
 expect((await setup('owner',undefined,200,[]).send('GET')).statusCode).toBe(403);
 const {send,calls}=setup();expect((await send('PUT',{policy:{...policy,timezone_name:'No/Zone'},expected_version:0,operation_id:OP})).statusCode).toBe(422);expect(calls).toHaveLength(0);
 expect((await setup('owner',{code:'P0001'},400).send('PUT',{policy,expected_version:0,operation_id:OP})).statusCode).toBe(409);
});
