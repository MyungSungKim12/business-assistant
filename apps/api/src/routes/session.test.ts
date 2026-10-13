import { it, expect } from 'vitest';
import { createApp } from '../app.js';

it('refreshes the session using the existing HTTP contract', async () => {
  const app = createApp({auth:{
    signIn:async()=>{throw new Error('unused');},
    refresh:async(token:string)=>{
      expect(token).toBe('refresh');
      return {accessToken:'new',refreshToken:'rotated',user:{userId:'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd',email:'owner@example.com',displayName:null}};
    },
    getUser:async()=>({userId:'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd',email:'owner@example.com',displayName:null}),
  }});
  const response = await app.inject({method:'POST',url:'/api/v1/auth/refresh',payload:{refresh_token:'refresh'}});
  expect(response.statusCode).toBe(200);
  expect(response.json().refresh_token).toBe('rotated');
  const me = await app.inject({url:'/api/v1/me',headers:{authorization:'Bearer new'}});
  expect(me.statusCode).toBe(200);
  expect(me.json().user_id).toBe('a9cc39fd-8e8c-4df8-a623-1f23a3a936bd');
  expect((await app.inject({url:'/api/v1/me'})).statusCode).toBe(401);
  await app.close();
});

