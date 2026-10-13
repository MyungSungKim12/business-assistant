import { z } from 'zod';

export type TrustProxy = boolean | number | string[];

/**
 * APP_TRUST_PROXY: 'false'(기본) | 'true' | 홉 수(정수) | 신뢰할 프록시 IP/CIDR 쉼표 목록.
 * 신뢰하지 않는 상태에서 X-Forwarded-For 를 믿으면 시도 제한을 우회당하므로 기본은 false 이다.
 */
export function parseTrustProxy(value: string | undefined): TrustProxy {
  const text = (value ?? '').trim();
  if (text === '' || /^(false|0|no|off)$/i.test(text)) return false;
  if (/^(true|yes|on)$/i.test(text)) return true;
  if (/^[1-9]\d*$/.test(text)) return Number(text);
  const entries = text.split(',').map((item) => item.trim()).filter(Boolean);
  if (entries.some((item) => !/^[0-9a-f:.]+(\/\d{1,3})?$/i.test(item))) throw new Error('invalid APP_TRUST_PROXY');
  return entries;
}

const trustProxy = z.string().optional().transform((value, context): TrustProxy => {
  try { return parseTrustProxy(value); } catch {
    context.addIssue({ code: 'custom', message: 'invalid APP_TRUST_PROXY' });
    return false;
  }
});
const flag = (fallback: boolean) => z.string().optional().transform((value) => {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(true|1|yes|on)$/i.test(value.trim());
});
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** 일반 API와 관리자 API가 같이 쓰는 필드. 서비스 키는 여기에 없다. */
const commonFields = {
  APP_SUPABASE_URL: z.url(),
  APP_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  APP_FILE_BUCKET: z.string().min(1).default('business-files'),
  APP_API_PORT: positive(8000),
  APP_API_HOST: z.string().trim().min(1).default('127.0.0.1'),
  APP_TRUST_PROXY: trustProxy,
  APP_BODY_LIMIT_BYTES: positive(1_048_576),
  APP_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_AUTH_RATE_LIMIT_ENABLED: flag(true),
  APP_AUTH_LOGIN_MAX: positive(10),
  APP_AUTH_LOGIN_WINDOW_SEC: positive(600),
  APP_AUTH_LOGIN_EMAIL_MAX: positive(30),
  APP_AUTH_SIGNUP_MAX: positive(5),
  APP_AUTH_SIGNUP_WINDOW_SEC: positive(3600),
  APP_AUTH_REFRESH_MAX: positive(60),
  APP_AUTH_REFRESH_WINDOW_SEC: positive(600),
  APP_AUTH_FAILURE_MIN_MS: z.coerce.number().int().min(0).max(5000).default(250),
};

/** 일반 API 프로세스 설정. APP_SUPABASE_SERVICE_KEY 는 스키마에 없으므로 환경에 있어도 읽지 않는다(무시). */
const ServerConfigSchema = z.object(commonFields);
type ParsedServerConfig = z.infer<typeof ServerConfigSchema>;
type RequiredKeys = 'APP_SUPABASE_URL' | 'APP_SUPABASE_PUBLISHABLE_KEY' | 'APP_FILE_BUCKET' | 'APP_API_PORT';

/** 필수 4개만 요구하고 나머지는 선택이라, 기존 코드·테스트의 최소 설정 객체가 그대로 유효하다. */
export type ServerConfig = Pick<ParsedServerConfig, RequiredKeys> & Partial<Omit<ParsedServerConfig, RequiredKeys>>;
export type ResolvedServerConfig = ParsedServerConfig;

/** .env.example 처럼 값이 빈 변수는 설정하지 않은 것으로 보고 기본값을 쓴다. */
function withoutBlank(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined && value.trim() !== ''));
}

function failure(error: z.ZodError): Error {
  const missing = error.issues.map((issue) => issue.path.join('.')).join(', ');
  return new Error(`서버 환경 변수를 확인해 주세요: ${missing}`);
}

export function parseServerConfig(environment: Record<string, string | undefined>): ResolvedServerConfig {
  const result = ServerConfigSchema.safeParse(withoutBlank(environment));
  if (result.success) return result.data;
  throw failure(result.error);
}

/** 관리자 API(admin-server.ts) 전용 설정. 서비스 키는 이 프로세스만 읽는다. */
const AdminConfigSchema = z.object({
  ...commonFields,
  APP_SUPABASE_SERVICE_KEY: z.string().min(1),
  APP_PLATFORM_ADMIN_USER_IDS: z.string().optional(),
  APP_ADMIN_HOST: z.string().trim().min(1).default('127.0.0.1'),
  APP_ADMIN_PORT: positive(8001),
});
export type ResolvedAdminConfig = z.infer<typeof AdminConfigSchema>;

export function parseAdminConfig(environment: Record<string, string | undefined>): ResolvedAdminConfig {
  const result = AdminConfigSchema.safeParse(withoutBlank(environment));
  if (!result.success) throw failure(result.error);
  if (result.data.APP_ADMIN_PORT === result.data.APP_API_PORT && result.data.APP_ADMIN_HOST === result.data.APP_API_HOST) {
    throw new Error('서버 환경 변수를 확인해 주세요: APP_ADMIN_PORT 는 APP_API_PORT 와 달라야 합니다.');
  }
  return result.data;
}

export function isProduction(environment: Record<string, string | undefined>): boolean {
  return environment.NODE_ENV === 'production' || environment.APP_ENVIRONMENT === 'production';
}

/** 인증 시도 제한 설정을 설정 객체에서 꺼낸다(없으면 기본값). */
export function authLimitSettings(config?: ServerConfig) {
  return {
    enabled: config?.APP_AUTH_RATE_LIMIT_ENABLED ?? true,
    login: { limit: config?.APP_AUTH_LOGIN_MAX ?? 10, windowMs: (config?.APP_AUTH_LOGIN_WINDOW_SEC ?? 600) * 1000 },
    loginEmail: { limit: config?.APP_AUTH_LOGIN_EMAIL_MAX ?? 30, windowMs: (config?.APP_AUTH_LOGIN_WINDOW_SEC ?? 600) * 1000 },
    signup: { limit: config?.APP_AUTH_SIGNUP_MAX ?? 5, windowMs: (config?.APP_AUTH_SIGNUP_WINDOW_SEC ?? 3600) * 1000 },
    refresh: { limit: config?.APP_AUTH_REFRESH_MAX ?? 60, windowMs: (config?.APP_AUTH_REFRESH_WINDOW_SEC ?? 600) * 1000 },
    failureMinMs: config?.APP_AUTH_FAILURE_MIN_MS ?? 250,
  };
}
export type AuthLimitSettings = ReturnType<typeof authLimitSettings>;
