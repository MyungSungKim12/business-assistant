// 의존성 없는 API 호출기: 토큰 전달, 요청 간격, 5xx/네트워크 오류 재시도, 오류에서 HTTP 상태와 detail만 추려낸다.

export class SeedHttpError extends Error {
  constructor(status, detail, { method = '', path = '', featureCode = null } = {}) {
    super(status ? `HTTP ${status}${detail ? ` ${detail}` : ''}` : detail || '네트워크 오류');
    this.status = status;
    this.detail = detail;
    this.method = method;
    this.path = path;
    this.featureCode = featureCode;
  }
}

/** dry-run에서 쓰기 요청을 시도하면 던진다(안전장치). */
export class DryRunWriteBlocked extends Error {}

const MAX_DETAIL = 200;

/** 서버 응답 본문에서 사람이 읽을 detail 한 줄만 꺼낸다(원문 전체는 버린다). */
export function extractDetail(text) {
  try {
    const body = JSON.parse(text);
    const value = typeof body?.detail === 'string' ? body.detail : typeof body?.message === 'string' ? body.message : '';
    return value.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
  } catch {
    return '';
  }
}
function extractFeature(text) {
  try { const code = JSON.parse(text)?.feature_code; return typeof code === 'string' ? code : null; } catch { return null; }
}

export function createClient({ baseUrl, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), delayMs = 50, retries = 2, dryRun = false, timeoutMs = 30_000 }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const stats = { requests: 0, writes: 0, retries: 0 };
  let token = null;
  let reauth = null;
  let first = true;

  async function pace() {
    if (first) { first = false; return; }
    if (delayMs > 0) await sleep(delayMs);
  }

  /**
   * operation_id가 있는 쓰기와 모든 조회는 5xx·네트워크 오류 때 같은 요청(같은 키)을 최대 retries번 다시 보낸다.
   * 키 없는 생성 요청은 중복 위험 때문에 다시 보내지 않는다(스크립트를 다시 실행하면 목록 조회로 이어서 진행한다).
   */
  async function request(method, path, { query, body, auth = true } = {}) {
    const isWrite = method !== 'GET';
    if (isWrite && dryRun) throw new DryRunWriteBlocked(`dry-run: ${method} ${path} 차단`);
    const keyed = body !== null && typeof body === 'object' && 'operation_id' in body;
    const attempts = isWrite && !keyed ? 1 : retries + 1;
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    let reauthed = false;
    for (let attempt = 1; ; attempt += 1) {
      await pace();
      stats.requests += 1;
      if (isWrite) stats.writes += 1;
      let response;
      let text = '';
      try {
        response = await fetchImpl(url, {
          method,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
      } catch {
        if (attempt < attempts) { stats.retries += 1; continue; }
        throw new SeedHttpError(0, '서버에 연결하지 못했습니다.', { method, path });
      }
      if (response.status === 401 && auth && reauth && !reauthed) {
        reauthed = true;
        await reauth();
        continue;
      }
      if (response.status >= 500 && attempt < attempts) { stats.retries += 1; continue; }
      if (!response.ok) throw new SeedHttpError(response.status, extractDetail(text), { method, path, featureCode: extractFeature(text) });
      if (response.status === 204 || text === '') return null;
      try { return JSON.parse(text); } catch { throw new SeedHttpError(response.status, '응답이 JSON이 아닙니다.', { method, path }); }
    }
  }

  /** 서명 URL로 파일 본문을 올린다. 로그인 토큰은 절대 보내지 않는다. */
  async function putBinary(url, bytes, contentType) {
    if (dryRun) throw new DryRunWriteBlocked('dry-run: 파일 업로드 차단');
    await pace();
    stats.requests += 1;
    stats.writes += 1;
    let response;
    try {
      response = await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new SeedHttpError(0, '파일 저장소에 연결하지 못했습니다.', { method: 'PUT', path: '(signed-url)' });
    }
    if (!response.ok) throw new SeedHttpError(response.status, '파일 업로드 실패', { method: 'PUT', path: '(signed-url)' });
  }

  return {
    stats,
    baseUrl: base,
    setToken(value) { token = value; },
    setReauth(fn) { reauth = fn; },
    get: (path, query) => request('GET', path, { query }),
    post: (path, body, query) => request('POST', path, { body, query }),
    put: (path, body) => request('PUT', path, { body }),
    patch: (path, body) => request('PATCH', path, { body }),
    del: (path) => request('DELETE', path),
    anonymousPost: (path, body) => request('POST', path, { body, auth: false }),
    putBinary,
  };
}
