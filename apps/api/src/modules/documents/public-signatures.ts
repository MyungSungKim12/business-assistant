import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const coordinate = z.number().min(0).max(1);
const signatureSchema = z.object({ token: tokenSchema, operation_id: z.uuid(), signer_name: z.string().trim().min(1).max(100), confirmed: z.literal(true), strokes: z.array(z.array(z.tuple([coordinate, coordinate])).min(1).max(500)).min(1).max(50) }).strict().superRefine((value, ctx) => {
  if (value.strokes.reduce((sum, stroke) => sum + stroke.length, 0) > 5000) ctx.addIssue({ code: 'custom', message: 'Signature is too large' });
  if (new Set(value.strokes.flat().map(([x, y]) => `${x},${y}`)).size < 2) ctx.addIssue({ code: 'custom', message: 'Signature needs at least two points' });
});
const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

const page = (nonce: string) => `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>동의서 확인</title><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f7f4ef;color:#342e29;font:16px/1.6 system-ui,sans-serif}.wrap{max-width:720px;margin:28px auto;padding:24px;background:#fff;border:1px solid #e8dfd4;border-radius:16px}h1{font-size:24px;margin:0 0 8px}p{color:#6c6258}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:#faf8f5;padding:18px;border-radius:10px;max-height:50vh;overflow:auto}label{display:block;font-weight:600;margin:18px 0 6px}input,button{font:inherit}input{width:100%;padding:12px;border:1px solid #d7cabb;border-radius:8px}canvas{display:block;width:100%;height:200px;border:1px solid #d7cabb;border-radius:8px;touch-action:none;background:#fff}button{margin-top:14px;padding:12px 18px;border:0;border-radius:8px;background:#66574b;color:#fff;font-weight:700}button:disabled{opacity:.55}#status{min-height:28px}.notice{font-size:14px}</style><main class="wrap"><h1>시술 동의서</h1><p class="notice">발행 당시 저장된 문서 내용입니다. 내용을 확인하고 서명해 주세요.</p><section id="content">문서를 확인하는 중…</section><form id="form" hidden><label for="name">서명자 이름</label><input id="name" maxlength="100" autocomplete="name" required><label for="sign">아래에 서명해 주세요</label><canvas id="sign" aria-label="서명 입력"></canvas><button id="clear" type="button">서명 지우기</button><label><input id="confirm" type="checkbox" required style="width:auto"> 내용을 읽고 동의합니다.</label><button id="submit" type="submit">서명 제출</button></form><p id="status" role="status"></p></main><script nonce="${nonce}">(()=>{const token=location.hash.slice(1),operationId=crypto.randomUUID();history.replaceState(null,'',location.pathname);const content=document.querySelector('#content'),form=document.querySelector('#form'),status=document.querySelector('#status'),canvas=document.querySelector('#sign'),ctx=canvas.getContext('2d');let strokes=[],active=null;const resize=()=>{const r=canvas.getBoundingClientRect(),d=devicePixelRatio||1;canvas.width=r.width*d;canvas.height=r.height*d;ctx.setTransform(d,0,0,d,0,0);ctx.lineWidth=2;ctx.lineCap='round';ctx.strokeStyle='#342e29'};const point=e=>{const r=canvas.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))]};const draw=()=>{const r=canvas.getBoundingClientRect();ctx.clearRect(0,0,r.width,r.height);for(const stroke of strokes){ctx.beginPath();stroke.forEach(([x,y],i)=>i?ctx.lineTo(x*r.width,y*r.height):ctx.moveTo(x*r.width,y*r.height));ctx.stroke()}if(active){ctx.beginPath();active.forEach(([x,y],i)=>i?ctx.lineTo(x*r.width,y*r.height):ctx.moveTo(x*r.width,y*r.height));ctx.stroke()}};new ResizeObserver(()=>{resize();draw()}).observe(canvas);canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);active=[point(e)];draw()});canvas.addEventListener('pointermove',e=>{if(active){active.push(point(e));draw()}});canvas.addEventListener('pointerup',()=>{if(active){strokes.push(active);active=null;draw()}});canvas.addEventListener('pointercancel',()=>{if(active){strokes.push(active);active=null;draw()}});document.querySelector('#clear').onclick=()=>{strokes=[];active=null;draw()};async function call(path,body){const response=await fetch('/api/v1/public/document-signatures/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store',credentials:'omit'});if(!response.ok)throw Error('서명 링크가 만료되었거나 취소되었습니다. 담당자에게 새 링크를 요청하세요.');return response.json()}(async()=>{if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('유효하지 않은 링크입니다.');const doc=await call('preview',{token});const title=document.createElement('h2');title.textContent=doc.title+' · 서식 v'+doc.template_version;const body=document.createElement('pre');body.textContent=doc.content;content.replaceChildren(title,body);form.hidden=false;status.textContent='만료 예정: '+new Date(doc.expires_at).toLocaleString('ko-KR')})().catch(e=>{content.textContent=e.message;status.textContent=''});form.addEventListener('submit',async e=>{e.preventDefault();if(!form.reportValidity()||active||strokes.length===0){status.textContent='이름, 동의 확인, 서명을 모두 입력해 주세요.';return}const button=document.querySelector('#submit');button.disabled=true;status.textContent='서명을 저장하는 중…';try{await call('sign',{token,operation_id:operationId,signer_name:document.querySelector('#name').value,confirmed:document.querySelector('#confirm').checked,strokes});form.hidden=true;status.textContent='서명이 저장되었습니다. 이 링크는 다시 사용할 수 없습니다.'}catch(err){status.textContent=err.message;button.disabled=false}})})();</script></html>`;

export function registerPublicDocumentSignatureRoutes(app: FastifyInstance, config: ServerConfig, fetcher: typeof fetch = fetch): void {
  const base = config.APP_SUPABASE_URL.replace(/\/+$/, '');
  const publishableKey = config.APP_SUPABASE_PUBLISHABLE_KEY;
  const attempts = new Map<string, { count: number; reset: number }>();
  app.get('/api/v1/public/document-signatures', async (_request, reply) => {
    const nonce = randomBytes(18).toString('base64');
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    return reply.type('text/html; charset=utf-8').send(page(nonce));
  });
  const rpc = async (request: { ip: string }, name: string, body: unknown) => {
    const now = Date.now(), existing = attempts.get(request.ip);
    if (!existing || existing.reset <= now) {
      if (attempts.size > 5000) for (const [ip, entry] of attempts) if (entry.reset <= now) attempts.delete(ip);
      if (attempts.size > 5000) return { __failureStatus: 429 };
      attempts.set(request.ip, { count: 1, reset: now + 60_000 });
    }
    else if (existing.count >= 20) return { __failureStatus: 429 };
    else existing.count++;
    try {
      const response = await fetcher(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error' });
      const data = await response.json().catch(() => null) as unknown;
      if (!response.ok) return { __failureStatus: response.status >= 500 ? 503 : 404 };
      return data;
    } catch { return { __failureStatus: 503 }; }
  };
  const sendFailure = (data: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    if (data && typeof data === 'object' && '__failureStatus' in data) {
      const status = (data as { __failureStatus: number }).__failureStatus;
      return reply.code(status).send({ detail: status === 503 ? '서명 서비스에 연결할 수 없습니다.' : status === 429 ? '요청이 많습니다. 잠시 후 다시 시도해 주세요.' : '서명 링크가 만료되었거나 이미 사용되었습니다.' });
    }
    return null;
  };
  const routeBody = z.object({ token: tokenSchema }).strict();
  app.post('/api/v1/public/document-signatures/preview', async (request, reply) => {
    const parsed = routeBody.safeParse(request.body);
    if (!parsed.success) return reply.code(404).send({ detail: '유효하지 않은 링크입니다.' });
    const data = await rpc(request, 'preview_customer_document_signature', { p_token_hash: hash(parsed.data.token) });
    const failure = sendFailure(data, reply); if (failure) return failure;
    if (!Array.isArray(data) || data.length !== 1) return reply.code(404).send({ detail: '서명 링크가 만료되었거나 이미 사용되었습니다.' });
    const row = data[0] as Record<string, unknown>;
    if (typeof row.title !== 'string' || typeof row.content !== 'string' || typeof row.expires_at !== 'string' || typeof row.template_version !== 'number') return reply.code(503).send({ detail: '문서를 불러오지 못했습니다.' });
    return { title: row.title, content: row.content, template_version: row.template_version, expires_at: row.expires_at };
  });
  app.post('/api/v1/public/document-signatures/sign', async (request, reply) => {
    const parsed = signatureSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ detail: '서명 정보를 확인해 주세요.' });
    const { token, operation_id, signer_name, strokes } = parsed.data;
    const result = await rpc(request, 'submit_customer_document_signature', { p_token_hash: hash(token), p_operation_id: operation_id, p_signer_name: signer_name, p_strokes: strokes });
    const failure = sendFailure(result, reply); if (failure) return failure;
    if (result !== true) return reply.code(404).send({ detail: '서명 링크를 처리할 수 없습니다.' });
    return { signed: true };
  });
}
