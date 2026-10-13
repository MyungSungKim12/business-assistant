// 명령줄 처리: 옵션 해석, 주소·계정 안전장치, 로그인, 매장 선택, 확인 질문, 단계 실행, 요약표.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient, SeedHttpError } from './client.mjs';
import { buildPlan, planSummary, resolveSteps, STEP_META, STEP_ORDER } from './plan.mjs';
import { runSteps } from './steps.mjs';
import { kstToday, maskEmail, redact, renderTable, seedUuid } from './util.mjs';

export const DEFAULT_API = 'http://127.0.0.1:8000/api/v1';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const ENV_KEYS = ['SEED_EMAIL', 'SEED_PASSWORD', 'BUSINESS_ASSISTANT_DEV_EMAIL', 'BUSINESS_ASSISTANT_DEV_PASSWORD', 'APP_API_BASE_URL'];

export class UsageError extends Error {}

export function helpText() {
  const lines = [
    '사용법: node scripts/seed-demo-data.mjs [옵션]',
    '',
    '로컬 API 서버(apps/api)를 HTTP로 호출해 기능별 [데모] 데이터를 만든다. 여러 번 실행해도 [데모] 표식 데이터는 중복 생성하지 않는다.',
    '',
    '옵션',
    '  --org <slug>        대상 매장 slug (기본 test). 역할이 owner/admin이어야 한다.',
    `  --api <url>         API 주소 (기본 ${DEFAULT_API}, 환경변수 APP_API_BASE_URL도 인식)`,
    '  --allow-remote      로컬(127.0.0.1/localhost)이 아닌 https 주소를 허용한다. 운영 서버에 넣지 않도록 주의.',
    '  --yes, -y           실행 전 확인 질문을 생략한다.',
    '  --dry-run           네트워크 요청을 보내지 않고 영역별 생성 예정 개수만 출력한다.',
    '  --only <영역,...>   일부 영역만 실행한다. 필요한 선행 영역은 자동으로 포함된다.',
    '  --env-file <경로>   .env 파일 위치 (기본: 저장소 루트 .env가 있으면 읽음). 값은 출력하지 않는다.',
    '  --delay-ms <숫자>   요청 사이 간격(기본 50ms).',
    '  --help, -h          이 도움말',
    '',
    '계정(환경변수): SEED_EMAIL / SEED_PASSWORD, 없으면 BUSINESS_ASSISTANT_DEV_EMAIL / BUSINESS_ASSISTANT_DEV_PASSWORD',
    '종료 코드: 0 성공(건너뜀 포함), 1 일부 단계 실패, 2 옵션·안전장치·로그인 오류',
    '',
    '영역(실행 순서)과 선행 영역',
  ];
  for (const key of STEP_ORDER) {
    const meta = STEP_META[key];
    lines.push(`  ${key.padEnd(13)} ${meta.label}${meta.needs.length ? `  [선행: ${meta.needs.join(', ')}]` : ''}`);
  }
  return lines;
}

export function parseArgs(argv) {
  const options = { org: 'test', api: null, allowRemote: false, yes: false, dryRun: false, only: null, envFile: null, delayMs: 50, help: false };
  const value = (index, name) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${name} 옵션에 값이 필요합니다.`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const take = () => { if (inline !== undefined) return inline; const result = value(index, flag); index += 1; return result; };
    if (flag === '--org') options.org = take();
    else if (flag === '--api') options.api = take();
    else if (flag === '--env-file') options.envFile = take();
    else if (flag === '--only') options.only = take().split(',').map((item) => item.trim()).filter(Boolean);
    else if (flag === '--delay-ms') {
      const delay = Number(take());
      if (!Number.isInteger(delay) || delay < 0 || delay > 10_000) throw new UsageError('--delay-ms는 0~10000 사이 정수여야 합니다.');
      options.delayMs = delay;
    } else if (flag === '--allow-remote') options.allowRemote = true;
    else if (flag === '--yes' || flag === '-y') options.yes = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new UsageError(`알 수 없는 옵션입니다: ${flag}`);
  }
  if (options.only) {
    const unknown = options.only.filter((key) => !STEP_ORDER.includes(key));
    if (unknown.length) throw new UsageError(`알 수 없는 영역입니다: ${unknown.join(', ')} (--help로 목록 확인)`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.org)) throw new UsageError('--org 값은 소문자·숫자·하이픈 slug여야 합니다.');
  return options;
}

/** .env 형식 텍스트에서 필요한 키만 꺼낸다(값은 어디에도 출력하지 않는다). */
export function parseEnvText(text) {
  const result = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !ENV_KEYS.includes(match[1])) continue;
    let content = match[2].trim();
    if ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'"))) content = content.slice(1, -1);
    else content = content.replace(/\s+#.*$/, '');
    result[match[1]] = content;
  }
  return result;
}

/** API 주소 안전 규칙: 로컬은 허용, 그 밖에는 https이면서 --allow-remote가 있어야 한다. */
export function validateApiUrl(raw, allowRemote) {
  let url;
  try { url = new URL(raw); } catch { throw new UsageError('API 주소 형식이 올바르지 않습니다.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('API 주소는 http 또는 https여야 합니다.');
  if (url.username || url.password) throw new UsageError('API 주소에 계정 정보를 넣을 수 없습니다.');
  const local = LOCAL_HOSTS.has(url.hostname);
  if (!local && url.protocol !== 'https:') throw new UsageError('로컬이 아닌 API 주소는 https만 허용합니다. 데모 데이터는 운영 서버에 넣지 마세요.');
  if (!local && !allowRemote) throw new UsageError(`로컬이 아닌 주소(${url.host})입니다. 정말 필요하면 --allow-remote를 붙이세요. 운영 서버에는 데모 데이터를 넣지 마세요.`);
  // .env의 APP_API_BASE_URL은 서버 주소만(http://127.0.0.1:8000) 담는 경우가 많다. 경로가 없으면 /api/v1을 붙인다.
  const path = url.pathname.replace(/\/+$/, '');
  return { href: `${url.origin}${path === '' ? '/api/v1' : path}`, local, host: url.host };
}

async function defaultReadText(path) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

export async function loadEnvironment(options, deps) {
  const fileEnv = {};
  const explicit = options.envFile !== null;
  const path = explicit ? options.envFile : fileURLToPath(new URL('../../.env', import.meta.url));
  const text = await (deps.readTextFile ?? defaultReadText)(path);
  if (text === null || text === undefined) {
    if (explicit) throw new UsageError('--env-file 파일을 읽을 수 없습니다.');
  } else Object.assign(fileEnv, parseEnvText(text));
  const env = deps.env ?? process.env;
  const pick = (key) => (env[key] !== undefined && env[key] !== '' ? env[key] : fileEnv[key]);
  return {
    email: pick('SEED_EMAIL') || pick('BUSINESS_ASSISTANT_DEV_EMAIL'),
    password: pick('SEED_PASSWORD') || pick('BUSINESS_ASSISTANT_DEV_PASSWORD'),
    api: pick('APP_API_BASE_URL'),
  };
}

function plannedLines(plan, keys) {
  return planSummary(plan, keys).map((item) => `  ${item.key.padEnd(13)} ${item.label}: ${Object.entries(item.counts).map(([label, n]) => `${label} ${n}`).join(', ')}`);
}

async function defaultAsk(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

/**
 * 진입 함수. deps로 env, fetch, out, err, ask, readTextFile, now, sleep을 바꿀 수 있다(테스트용).
 * 반환값이 종료 코드다.
 */
export async function main(argv, deps = {}) {
  const out = deps.out ?? ((line) => console.log(line));
  const err = deps.err ?? ((line) => console.error(line));
  const secrets = [];
  try {
    const options = parseArgs(argv);
    if (options.help) { helpText().forEach(out); return 0; }

    const env = await loadEnvironment(options, deps);
    const target = validateApiUrl(options.api ?? env.api ?? DEFAULT_API, options.allowRemote);
    const keys = resolveSteps(options.only);
    const now = (deps.now ?? (() => new Date()))();
    const plan = buildPlan(kstToday(now));

    if (options.dryRun) {
      out('[dry-run] 네트워크 요청을 보내지 않습니다. 영역별 생성 예정(최대) 개수:');
      plannedLines(plan, keys).forEach(out);
      out('이미 [데모] 표식 데이터가 있으면 실제 실행 때 건너뜁니다.');
      return 0;
    }

    if (!env.email || !env.password) {
      err('계정이 필요합니다. 환경변수 SEED_EMAIL/SEED_PASSWORD (또는 BUSINESS_ASSISTANT_DEV_EMAIL/BUSINESS_ASSISTANT_DEV_PASSWORD)를 설정하세요.');
      return 2;
    }
    secrets.push(env.password);

    const client = createClient({ baseUrl: target.href, fetchImpl: deps.fetch ?? globalThis.fetch, sleep: deps.sleep, delayMs: options.delayMs, dryRun: false });
    const login = async () => {
      let session;
      try { session = await client.anonymousPost('/auth/login', { email: env.email, password: env.password }); }
      catch (error) { throw new UsageError(`로그인에 실패했습니다${error instanceof SeedHttpError && error.status ? ` (HTTP ${error.status})` : ''}. 계정 정보를 확인하세요.`); }
      if (!session?.access_token) throw new UsageError('로그인 응답에 토큰이 없습니다.');
      secrets.push(session.access_token);
      client.setToken(session.access_token);
    };
    await login();
    client.setReauth(async () => { await login(); });

    const organizations = await client.get('/organizations');
    const organization = organizations.find((item) => item.slug === options.org);
    if (!organization) throw new UsageError(`매장(slug: ${options.org})을 찾을 수 없습니다. --org 값을 확인하세요.`);
    if (organization.role !== 'owner' && organization.role !== 'admin') throw new UsageError(`이 계정은 매장 "${options.org}"의 owner/admin이 아닙니다(현재 역할: ${organization.role}). 쓰기 권한이 필요합니다.`);

    let features = null;
    try {
      const entitlements = await client.get(`/organizations/${organization.id}/entitlements`);
      if (Array.isArray(entitlements?.features)) features = new Set(entitlements.features);
    } catch { features = null; }

    out('데모 데이터 시드 대상');
    out(`  API 주소 : ${target.href}${target.local ? '' : '  (원격)'}`);
    out(`  매장     : ${organization.name} (${organization.slug}, 역할 ${organization.role})`);
    out(`  계정     : ${maskEmail(env.email)}`);
    out(`  영역     : ${keys.join(', ')}`);
    if (!options.yes) {
      const ask = deps.ask ?? (process.stdin.isTTY ? defaultAsk : null);
      if (!ask) { err('확인 질문에 답할 수 없는 환경입니다. 내용을 확인한 뒤 --yes를 붙여 다시 실행하세요.'); return 2; }
      const answer = String(await ask('위 대상에 [데모] 데이터를 만들까요? (y/N) ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') { out('취소했습니다.'); return 2; }
    }

    const ctx = {
      client, orgId: organization.id, plan, state: {}, features, secrets, out,
      uid: (key) => seedUuid(organization.id, key), created: () => {}, existed: () => {},
    };
    out('시작합니다.');
    const results = await runSteps(ctx, keys);

    out('');
    out('요약');
    const label = { ok: '성공', skipped: '건너뜀', failed: '실패' };
    renderTable(['영역', '결과', '생성', '기존', '비고'], results.map((r) => [r.key, label[r.status], r.createdText || '-', r.existedText || '-', r.note || ''])).forEach(out);
    const failed = results.filter((r) => r.status === 'failed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    out(`성공 ${results.filter((r) => r.status === 'ok').length}, 건너뜀 ${skipped}, 실패 ${failed} (요청 ${client.stats.requests}회, 재시도 ${client.stats.retries}회)`);
    if (failed > 0) { err('일부 영역이 실패했습니다. 원인을 해결하고 다시 실행하면 이미 만든 데이터는 건너뛰고 이어서 만듭니다.'); return 1; }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { err(redact(error.message, secrets)); return 2; }
    err(`예상하지 못한 오류: ${redact(error instanceof Error ? error.message : String(error), secrets)}`);
    return 1;
  }
}
