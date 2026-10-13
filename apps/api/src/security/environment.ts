import { isProduction } from '../config.js';

export type Environment = Record<string, string | undefined>;
export type EnvironmentReport = { errors: string[]; warnings: string[] };

const SERVICE_ONLY_KEYS = ['APP_SUPABASE_SERVICE_KEY', 'APP_PLATFORM_ADMIN_USER_IDS'] as const;
const DEV_LOGIN_KEYS = ['BUSINESS_ASSISTANT_DEV_AUTO_LOGIN', 'BUSINESS_ASSISTANT_DEV_EMAIL', 'BUSINESS_ASSISTANT_DEV_PASSWORD'] as const;
const TRUTHY = /^(true|1|yes|on)$/i;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i;

export type ProcessKind = 'api' | 'admin';

/**
 * 시작 시 환경 점검. errors 가 있으면 프로세스를 시작하지 않는다.
 * - 일반 API(api): 서비스 키·관리자 목록은 읽지 않으므로 있으면 경고(무시됨).
 * - 공통: 개발용 자동 로그인(BUSINESS_ASSISTANT_DEV_AUTO_LOGIN)이 production 에서 켜져 있으면 거부한다.
 *   값(계정·비밀번호)은 메시지에 싣지 않고 변수 이름만 적는다.
 */
export function inspectEnvironment(environment: Environment, kind: ProcessKind): EnvironmentReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = isProduction(environment);
  if (kind === 'api') {
    for (const key of SERVICE_ONLY_KEYS) {
      if (environment[key]) warnings.push(`${key} 가 환경에 있지만 일반 API 는 이 값을 사용하지 않고 무시합니다. 관리자 기능은 admin-server 에서만 실행하세요.`);
    }
  }
  const autoLogin = environment.BUSINESS_ASSISTANT_DEV_AUTO_LOGIN;
  if (autoLogin && TRUTHY.test(autoLogin.trim())) {
    if (production) errors.push('BUSINESS_ASSISTANT_DEV_AUTO_LOGIN 은 production 환경에서 사용할 수 없습니다. 환경에서 제거하세요.');
    else warnings.push('BUSINESS_ASSISTANT_DEV_AUTO_LOGIN 이 켜져 있습니다. 서버는 이 값을 사용하지 않지만 개발 환경에서만 두세요.');
  }
  if (production) {
    for (const key of DEV_LOGIN_KEYS) {
      if (environment[key] && key !== 'BUSINESS_ASSISTANT_DEV_AUTO_LOGIN') warnings.push(`${key} 가 production 환경에 설정되어 있습니다. 제거하세요(서버는 사용하지 않고 무시합니다).`);
    }
  }
  return { errors, warnings };
}

/** 서버가 쓰지 않는 비밀값(서비스 키·개발용 계정)을 프로세스 환경에서 지워 다른 코드가 읽지 못하게 한다. */
export function scrubEnvironment(environment: Environment, kind: ProcessKind): void {
  const keys = [...DEV_LOGIN_KEYS, ...(kind === 'api' ? SERVICE_ONLY_KEYS : [])];
  for (const key of keys) delete environment[key];
}

/** 루프백이 아닌 주소에 바인딩하면 경고 문구를 돌려준다. */
export function bindWarning(host: string): string | null {
  if (LOOPBACK.test(host.trim())) return null;
  return `${host} 에 바인딩합니다. 이 주소는 외부에서 접근할 수 있으므로 HTTPS 리버스 프록시와 방화벽 뒤에서만 사용하세요(docs/guide/admin/deployment.md).`;
}
