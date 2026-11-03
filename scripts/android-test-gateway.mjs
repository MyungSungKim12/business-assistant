import { createServer, request } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Development only: keep the desktop, business APIs and local filesystem off the tunnel.
export function createAndroidTestGateway({ token, apkPath, upstream = 'http://127.0.0.1:8000' }) {
  if (!token || token.length < 24) throw new Error('A random download token is required');
  return createServer((incoming, outgoing) => {
    outgoing.setHeader('Cache-Control', 'no-store');
    const url = new URL(incoming.url, 'http://localhost');
    if (incoming.method === 'GET' && url.pathname === `/download/${token}/app-debug.apk`) {
      if (!existsSync(apkPath)) { outgoing.writeHead(503); outgoing.end('APK is still building. Try again shortly.'); return; }
      outgoing.setHeader('Content-Type', 'application/vnd.android.package-archive');
      outgoing.setHeader('Content-Disposition', 'attachment; filename="business-assistant-phone.apk"');
      const stream = createReadStream(apkPath);
      stream.on('error', () => outgoing.destroy());
      stream.pipe(outgoing);
      return;
    }
    const path = url.pathname;
    const allowed = (['GET','PUT'].includes(incoming.method) && /^\/api\/v1\/organizations\/[0-9a-f-]{36}\/mobile\/phone-retention-consent$/.test(path))
      || (incoming.method === 'GET' && /^\/api\/v1\/(health|organizations)$/.test(path))
      || (incoming.method === 'POST' && /^\/api\/v1\/auth\/(login|refresh)$/.test(path))
      || (incoming.method === 'GET' && /^\/api\/v1\/organizations\/[0-9a-f-]{36}\/mobile\/phone-directory(?:-sync)?$/.test(path))
      || (incoming.method === 'POST' && /^\/api\/v1\/organizations\/[0-9a-f-]{36}\/mobile\/(phone-identification|phone-memos|incoming-calls)$/.test(path));
    if (!allowed) { outgoing.writeHead(404); outgoing.end('Not found'); return; }
    const chunks = [];
    let size = 0;
    incoming.on('data', chunk => {
      size += chunk.length;
      if (size <= 64 * 1024) chunks.push(chunk);
    });
    incoming.on('end', () => {
      if (size > 64 * 1024) { outgoing.writeHead(413); outgoing.end('Request too large'); return; }
      const headers = { accept: 'application/json' };
      if (incoming.headers.authorization) headers.authorization = incoming.headers.authorization;
      if (incoming.headers['content-type']) headers['content-type'] = incoming.headers['content-type'];
      const proxy = request(new URL(path + url.search, upstream), { method: incoming.method, headers, timeout: 15_000 }, response => {
        outgoing.writeHead(response.statusCode ?? 502, { 'Content-Type': response.headers['content-type'] ?? 'application/json' });
        response.pipe(outgoing);
      });
      proxy.on('timeout', () => proxy.destroy(new Error('API timeout')));
      proxy.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end('Local API unavailable'); });
      proxy.end(Buffer.concat(chunks));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const server = createAndroidTestGateway({
    token: process.env.ANDROID_TEST_DOWNLOAD_TOKEN,
    apkPath: resolve(root, 'apps/android-companion/app/build/outputs/apk/debug/app-debug.apk'),
  });
  server.listen(8789, '127.0.0.1', () => console.log('Android test gateway ready on 127.0.0.1:8789'));
}
