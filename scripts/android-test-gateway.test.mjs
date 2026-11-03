import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAndroidTestGateway } from './android-test-gateway.mjs';

test('tunnel gateway restricts routes, keeps bearer auth and requires the download token', async t => {
  const backend = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ authorization: req.headers.authorization, path: req.url })); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const gateway = createAndroidTestGateway({ token: 'a'.repeat(32), apkPath: new URL(import.meta.url), upstream: `http://127.0.0.1:${backend.address().port}` });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(() => { gateway.closeAllConnections(); gateway.close(); backend.closeAllConnections(); backend.close(); });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  for (const route of ['/api/v1/customers', '/api/v1/organizations/123/customers', '/.env', '/app-debug.apk', `/download/${'b'.repeat(32)}/app-debug.apk`]) {
    assert.equal((await fetch(base + route)).status, 404);
  }
  const response = await fetch(base + '/api/v1/organizations', { headers: { authorization: 'Bearer test-token' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authorization, 'Bearer test-token');
  const call = await fetch(base + '/api/v1/organizations/a9cc39fd-8e8c-4df8-a623-1f23a3a936bd/mobile/incoming-calls', { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(call.status, 200);
  assert.equal((await call.json()).authorization, 'Bearer test-token');
  for(const method of ['GET','PUT']){
    const consent=await fetch(base+'/api/v1/organizations/a9cc39fd-8e8c-4df8-a623-1f23a3a936bd/mobile/phone-retention-consent',{method,headers:{authorization:'Bearer test-token'},...(method==='PUT'?{body:'{}'}:{})});
    assert.equal(consent.status,200);assert.equal((await consent.json()).authorization,'Bearer test-token');
  }
  assert.equal((await fetch(base+'/api/v1/organizations/a9cc39fd-8e8c-4df8-a623-1f23a3a936bd/phone/inbox')).status,404);
  const syncPath='/api/v1/organizations/a9cc39fd-8e8c-4df8-a623-1f23a3a936bd/mobile/phone-directory-sync';
  const sync=await fetch(base+syncPath+'?cursor=d1:signed',{headers:{authorization:'Bearer test-token'}});
  assert.equal(sync.status,200);assert.equal((await sync.json()).authorization,'Bearer test-token');
  assert.equal((await fetch(base+syncPath,{method:'POST'})).status,404);
  assert.equal((await fetch(base+'/api/v1/organizations/a9cc39fd-8e8c-4df8-a623-1f23a3a936bd/phone/caller-profile',{method:'POST'})).status,404);
  assert.equal((await fetch(base + '/api/v1/organizations/a9cc39fd-8e8c-4df8-a623-1f23a3a936bd/mobile/incoming-calls')).status, 404);
  assert.equal((await fetch(base + `/download/${'a'.repeat(32)}/app-debug.apk`)).status, 200);
  assert.equal((await fetch(base + '/api/v1/auth/login', { method: 'POST', body: 'x'.repeat(65 * 1024) })).status, 413);
});
