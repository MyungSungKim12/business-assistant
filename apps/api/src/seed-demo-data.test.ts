/* eslint-disable @typescript-eslint/no-explicit-any */
// 데모 시드 스크립트(scripts/seed-demo-data.mjs) 테스트.
// 가짜 서버는 실제 Fastify 라우트(zod 검증 포함)를 쓰므로, 스크립트가 보내는 본문이 실제 API 형식과 어긋나면 여기서 실패한다.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFakeBackend, ORG_ID, TEST_EMAIL, TEST_PASSWORD, TEST_REFRESH, TEST_TOKEN, type FakeOptions } from './seed-demo-data.testkit.js';

const seedDir = resolve(import.meta.dirname, '../../../scripts/seed');
const load = (name: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(resolve(seedDir, name)).href);
const NOW = new Date('2026-10-13T03:00:00Z');

type Backend = ReturnType<typeof createFakeBackend>;
async function run(args: string[], options: Partial<FakeOptions> = {}, extra: Record<string, unknown> = {}, backend?: Backend) {
  const fake = backend ?? createFakeBackend({ now: NOW, ...options });
  const cli = await load('cli.mjs');
  const out: string[] = [];
  const err: string[] = [];
  const code: number = await cli.main(args, {
    env: { SEED_EMAIL: TEST_EMAIL, SEED_PASSWORD: TEST_PASSWORD }, fetch: fake.fetch, out: (line: string) => out.push(line), err: (line: string) => err.push(line),
    readTextFile: async () => null, now: () => NOW, sleep: async () => undefined, ...extra,
  });
  return { code, out, err, text: [...out, ...err].join('\n'), backend: fake };
}
const base = ['--yes', '--delay-ms', '0'];
const writes = (backend: Backend) => backend.requests.filter((r) => r.method !== 'GET' && !r.path.endsWith('/auth/login'));

describe('seed-demo-data', () => {
  it('dry-run은 요청을 한 건도 보내지 않고 영역별 예정 개수를 출력한다', async () => {
    const result = await run(['--dry-run'], {}, { fetch: () => { throw new Error('dry-run must not use the network'); } });
    expect(result.code).toBe(0);
    expect(result.backend.requests).toHaveLength(0);
    expect(result.text).toContain('고객 10');
    expect(result.text).toContain('파일 10');
  });

  it('정상 실행하면 영역별 개수가 계획과 일치하고 모든 단계가 성공한다', async () => {
    const plan = (await load('plan.mjs')).buildPlan(createFakeBackend({ now: NOW }).today);
    const { code, text, backend } = await run(base);
    const s = backend.store;
    expect(text).toContain('성공 18, 건너뜀 0, 실패 0');
    expect(code).toBe(0);
    expect(s.customers).toHaveLength(plan.customers.length);
    expect(s.customers.every((c) => c.name.startsWith('[데모]') && /^010-0000-\d{4}$/.test(c.phone) && c.email.endsWith('@example.com'))).toBe(true);
    expect(s.tasks).toHaveLength(10);
    expect(new Set(s.tasks.map((t) => t.status))).toEqual(new Set(['open', 'in_progress', 'done', 'canceled']));
    expect(s.staff).toHaveLength(10);
    expect(s.hours.size).toBe(10);
    expect(s.timeOff).toHaveLength(plan.timeOff.length);
    expect(s.services).toHaveLength(10);
    expect(s.resources.filter((r) => r.kind === 'room')).toHaveLength(5);
    expect(s.resources.filter((r) => r.kind === 'equipment')).toHaveLength(5);
    expect(s.requirements.size).toBe(10);
    expect(s.appointments).toHaveLength(10);
    expect(new Set(s.appointments.map((a) => a.status))).toEqual(new Set(['completed', 'no_show', 'canceled', 'checked_in', 'confirmed', 'reserved']));
    expect(s.appointments.filter((a) => a.status === 'canceled').every((a) => a.cancellation_reason)).toBe(true);
    expect(s.appointments.filter((a) => a.resource_ids.length > 0)).toHaveLength(10);
    expect(s.treatments).toHaveLength(10);
    expect(new Set(s.treatments.map((t) => t.status))).toEqual(new Set(['completed', 'cancelled', 'in_progress', 'draft']));
    expect(s.drafts).toHaveLength(plan.saleDrafts.length);
    expect(s.products).toHaveLength(10);
    expect(s.products.filter((p) => p.kind === 'membership')).toHaveLength(3);
    expect(s.ledger.filter((l) => l.movement_kind === 'receipt')).toHaveLength(7);
    expect(s.ledger.some((l) => ['disposal', 'stocktake', 'supplier_return'].includes(l.movement_kind))).toBe(true);
    expect(s.products.every((p) => p.stock_quantity >= 0)).toBe(true);
    expect(s.visits.filter((v) => v.appointment_id === null)).toHaveLength(plan.flows.length);
    expect(s.visits.filter((v) => v.appointment_id !== null).length).toBeGreaterThan(0);
    expect(s.wallets).toHaveLength(2);
    expect(s.walletUsages.map((u) => u.mode).sort()).toEqual(['count', 'money']);
    expect(s.refunds).toHaveLength(2);
    expect(s.carts.some((c) => c.status === 'collecting')).toBe(true);
    expect(s.carts.some((c) => c.discount_kind === 'percent')).toBe(true);
    expect(s.receipts.some((r) => r.method === 'transfer') && s.receipts.some((r) => r.method === 'card') && s.receipts.some((r) => r.method === 'cash')).toBe(true);
    expect(s.closes).toHaveLength(1);
    expect(s.closes[0].business_date).toBe(plan.closeDate);
    expect(s.closes[0].business_date < backend.today).toBe(true);
    expect(s.finance.filter((f) => f.memo.startsWith('[데모]'))).toHaveLength(10);
    expect(s.templates).toHaveLength(4);
    expect(s.templates.filter((t) => t.status === 'published')).toHaveLength(3);
    expect(s.documents).toHaveLength(10);
    expect(s.issued).toHaveLength(3);
    expect(s.events.map((e) => e.action).sort()).toEqual(['deliver', 'sign', 'sign']);
    expect(s.files).toHaveLength(10);
    expect(s.files.every((f) => !f.is_archived)).toBe(true);
    expect(s.uploads).toHaveLength(10);
  });

  it('두 번째 실행은 새로 만드는 것이 없고 쓰기 요청도 보내지 않는다', async () => {
    const first = await run(base);
    expect(first.code).toBe(0);
    const snapshot = JSON.stringify(first.backend.created);
    const before = first.backend.requests.length;
    const second = await run(base, {}, {}, first.backend);
    expect(second.code).toBe(0);
    expect(JSON.stringify(first.backend.created)).toBe(snapshot);
    expect(writes({ ...first.backend, requests: first.backend.requests.slice(before) } as Backend)).toHaveLength(0);
    expect(second.text).toContain('성공 18, 건너뜀 0, 실패 0');
  });

  it('한 영역이 실패해도 나머지는 계속하고 요약에 실패를 표시하며 종료 코드 1을 돌려준다', async () => {
    const intercept = (method: string, path: string) => (method === 'POST' && path.endsWith('/finance-transactions') ? { status: 503, body: { detail: 'Finance service unavailable', secret: TEST_TOKEN } } : null);
    const { code, text, out, backend } = await run(base, { intercept });
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/finance\s+실패/);
    expect(text).toContain('HTTP 503 Finance service unavailable');
    expect(text).not.toContain('requestId');
    expect(text).not.toContain(TEST_TOKEN);
    expect(backend.store.files).toHaveLength(10);
    expect(backend.store.documents).toHaveLength(10);
    expect(backend.store.customers).toHaveLength(10);
    expect(text).toContain('성공 17, 건너뜀 0, 실패 1');
  });

  it('선행 단계가 실패하면 그 단계에 의존하는 영역만 건너뛴다', async () => {
    const intercept = (method: string, path: string) => (method === 'POST' && path.endsWith('/appointment-services') ? { status: 500, body: { detail: 'boom' } } : null);
    const { code, text, backend } = await run(base, { intercept });
    expect(code).toBe(1);
    expect(text).toMatch(/requirements\s+건너뜀/);
    expect(text).toMatch(/appointments\s+건너뜀/);
    expect(backend.store.treatments).toHaveLength(10);
    expect(backend.store.files).toHaveLength(10);
  });

  it('기능 키가 없는 구독은 해당 영역을 건너뛰고(실패 아님) 나머지를 계속한다', async () => {
    const { code, text, backend } = await run(base, { features: ['crm.basic', 'task.basic', 'files.basic'] });
    expect(code).toBe(0);
    expect(text).toMatch(/finance\s+건너뜀/);
    expect(text).toContain('finance.basic');
    expect(backend.store.customers).toHaveLength(10);
    expect(backend.store.files).toHaveLength(10);
    expect(backend.store.finance).toHaveLength(0);
  });

  it('원격 주소와 owner/admin이 아닌 계정을 거부한다', async () => {
    for (const args of [['--api', 'http://example.com/api/v1'], ['--api', 'https://example.com/api/v1'], ['--api', 'http://example.com/api/v1', '--allow-remote']]) {
      const result = await run([...base, ...args]);
      expect(result.code).toBe(2);
      expect(result.backend.requests).toHaveLength(0);
    }
    const viaEnv = await run(base, {}, { env: { SEED_EMAIL: TEST_EMAIL, SEED_PASSWORD: TEST_PASSWORD, APP_API_BASE_URL: 'https://prod.example.com/api/v1' } });
    expect(viaEnv.code).toBe(2);
    expect(viaEnv.backend.requests).toHaveLength(0);

    const allowed = await run([...base, '--only', 'customers', '--api', 'https://staging.example.com/api/v1', '--allow-remote']);
    expect(allowed.code).toBe(0);
    expect(allowed.backend.store.customers).toHaveLength(10);

    const member = await run(base, { role: 'member' });
    expect(member.code).toBe(2);
    expect(member.text).toContain('owner/admin');
    expect(writes(member.backend)).toHaveLength(0);

    const missingOrg = await run([...base, '--org', 'nope']);
    expect(missingOrg.code).toBe(2);
    expect(writes(missingOrg.backend)).toHaveLength(0);
  });

  it('출력에 비밀번호·토큰·서명 URL이 들어가지 않고 이메일은 가려진다', async () => {
    const full = await run(base);
    const failing = await run(base, { intercept: (method, path) => (method === 'POST' && path.endsWith('/tasks') ? { status: 400, body: { detail: `bad ${TEST_PASSWORD} ${TEST_TOKEN}` } } : null) });
    const wrong = await run(base, {}, { env: { SEED_EMAIL: TEST_EMAIL, SEED_PASSWORD: 'wrong-password-value' } });
    expect(wrong.code).toBe(2);
    for (const result of [full, failing, wrong]) {
      for (const secret of [TEST_PASSWORD, TEST_TOKEN, TEST_REFRESH, 'upload-secret', 'wrong-password-value']) expect(result.text).not.toContain(secret);
      expect(result.text).not.toContain(TEST_EMAIL);
    }
    expect(full.text).toContain('ow***@example.com');
    expect(failing.code).toBe(1);
    expect(failing.text).toContain('HTTP 400');
  });

  it('확인 질문: 거절하면 아무것도 쓰지 않고, 승인하면 진행한다', async () => {
    const no = await run(['--only', 'customers', '--delay-ms', '0'], {}, { ask: async () => 'n' });
    expect(no.code).toBe(2);
    expect(writes(no.backend)).toHaveLength(0);
    expect(no.text).toContain('테스트 매장');
    const yes = await run(['--only', 'customers', '--delay-ms', '0'], {}, { ask: async () => 'y' });
    expect(yes.code).toBe(0);
    expect(yes.backend.store.customers).toHaveLength(10);
  });

  it('계정이 없으면 안내하고 종료하며, 개발용 환경변수를 대신 쓸 수 있다', async () => {
    const none = await run(base, {}, { env: {} });
    expect(none.code).toBe(2);
    expect(none.backend.requests).toHaveLength(0);
    const dev = await run([...base, '--only', 'tasks'], {}, { env: { BUSINESS_ASSISTANT_DEV_EMAIL: TEST_EMAIL, BUSINESS_ASSISTANT_DEV_PASSWORD: TEST_PASSWORD } });
    expect(dev.code).toBe(0);
    expect(dev.backend.store.tasks).toHaveLength(10);
    const envFile = await run([...base, '--only', 'tasks', '--env-file', 'x.env'], {}, { env: {}, readTextFile: async () => `# 주석\nSEED_EMAIL="${TEST_EMAIL}"\nexport SEED_PASSWORD='${TEST_PASSWORD}'\nOTHER=1\n` });
    expect(envFile.code).toBe(0);
    expect(envFile.text).not.toContain(TEST_PASSWORD);
  });

  it('--only는 선행 영역을 자동으로 포함하고 알 수 없는 영역은 거부한다', async () => {
    const plan = await load('plan.mjs');
    expect(plan.resolveSteps(['appointments'])).toEqual(['customers', 'staff', 'services', 'resources', 'requirements', 'appointments']);
    expect(plan.resolveSteps(['sales'])).toEqual(['customers', 'treatments', 'saleDrafts', 'products', 'inventory', 'sales']);
    const bad = await run([...base, '--only', 'nothing']);
    expect(bad.code).toBe(2);
    const partial = await run([...base, '--only', 'documents']);
    expect(partial.code).toBe(0);
    expect(partial.backend.store.templates).toHaveLength(4);
    expect(partial.backend.store.documents).toHaveLength(10);
    expect(partial.backend.store.customers).toHaveLength(0);
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.text).toContain('선행: customers, staff');
  });

  it('서버 주소만 있는 APP_API_BASE_URL에는 /api/v1을 붙이고, 형식이 이상한 주소는 거부한다', async () => {
    const { validateApiUrl } = await load('cli.mjs');
    expect(validateApiUrl('http://127.0.0.1:8000', false).href).toBe('http://127.0.0.1:8000/api/v1');
    expect(validateApiUrl('http://localhost:8000/api/v1/', false).href).toBe('http://localhost:8000/api/v1');
    expect(() => validateApiUrl('ftp://127.0.0.1/x', false)).toThrow();
    expect(() => validateApiUrl('https://user:pw@example.com/api/v1', true)).toThrow();
    expect(() => validateApiUrl('not a url', false)).toThrow();
  });

  it('결정적 operation_id는 조직별로 다르고 UUID 형식을 만족한다', async () => {
    const { seedUuid } = await load('util.mjs');
    const a = seedUuid(ORG_ID, 'x');
    expect(a).toBe(seedUuid(ORG_ID, 'x'));
    expect(a).not.toBe(seedUuid(ORG_ID, 'y'));
    expect(a).not.toBe(seedUuid('33333333-3333-4333-8333-333333333333', 'x'));
    expect(z.uuid().safeParse(a).success).toBe(true);
  });

  it('클라이언트는 5xx·네트워크 오류를 키 있는 쓰기와 조회에서만 최대 2회 재시도한다', async () => {
    const { createClient, SeedHttpError } = await load('client.mjs');
    const make = (failures: number, status = 503) => {
      const calls: string[] = [];
      let left = failures;
      const fetchImpl = async (_url: URL, init: RequestInit) => {
        calls.push(String(init.method));
        if (left-- > 0) return new Response(JSON.stringify({ detail: 'temporary' }), { status });
        return new Response('{"ok":true}', { status: 200 });
      };
      return { calls, client: createClient({ baseUrl: 'http://127.0.0.1:8000/api/v1', fetchImpl, delayMs: 0, sleep: async () => undefined }) };
    };
    const get = make(2);
    await expect(get.client.get('/x')).resolves.toEqual({ ok: true });
    expect(get.calls).toHaveLength(3);
    const keyed = make(2);
    await expect(keyed.client.post('/x', { operation_id: 'a' })).resolves.toEqual({ ok: true });
    expect(keyed.calls).toHaveLength(3);
    const exhausted = make(5);
    await expect(exhausted.client.get('/x')).rejects.toMatchObject({ status: 503, detail: 'temporary' });
    expect(exhausted.calls).toHaveLength(3);
    const plain = make(1);
    await expect(plain.client.post('/x', { name: 'no key' })).rejects.toBeInstanceOf(SeedHttpError);
    expect(plain.calls).toHaveLength(1);
    const invalid = make(1, 422);
    await expect(invalid.client.get('/x')).rejects.toMatchObject({ status: 422 });
    expect(invalid.calls).toHaveLength(1);
    const dry = createClient({ baseUrl: 'http://127.0.0.1:8000/api/v1', fetchImpl: async () => { throw new Error('no network'); }, delayMs: 0, dryRun: true });
    await expect(dry.post('/x', { a: 1 })).rejects.toThrow('dry-run');
  });
});
