import { describe, expect, it } from 'vitest';
import { authLimitSettings, parseAdminConfig, parseServerConfig, parseTrustProxy } from './config.js';

const base = { APP_SUPABASE_URL: 'https://example.supabase.co', APP_SUPABASE_PUBLISHABLE_KEY: 'key' };

describe('parseServerConfig', () => {
  it('rejects an incomplete Supabase server configuration', () => {
    expect(() => parseServerConfig({ APP_SUPABASE_PUBLISHABLE_KEY: 'key' }))
      .toThrow(/APP_SUPABASE_URL/);
  });

  it('기본값은 기존 동작(127.0.0.1:8000, 프록시 비신뢰, 1MiB)을 유지한다', () => {
    const config = parseServerConfig(base);
    expect(config).toMatchObject({
      APP_API_HOST: '127.0.0.1', APP_API_PORT: 8000, APP_TRUST_PROXY: false, APP_BODY_LIMIT_BYTES: 1_048_576, APP_FILE_BUCKET: 'business-files', APP_LOG_LEVEL: 'info',
      APP_AUTH_RATE_LIMIT_ENABLED: true, APP_AUTH_LOGIN_MAX: 10, APP_AUTH_LOGIN_WINDOW_SEC: 600, APP_AUTH_SIGNUP_MAX: 5, APP_AUTH_SIGNUP_WINDOW_SEC: 3600,
    });
  });

  it('호스트·포트·프록시·본문 한도·시도 제한을 환경 변수로 바꾼다', () => {
    const config = parseServerConfig({ ...base, APP_API_HOST: '0.0.0.0', APP_API_PORT: '9000', APP_TRUST_PROXY: '1', APP_BODY_LIMIT_BYTES: '2048', APP_AUTH_LOGIN_MAX: '3', APP_AUTH_RATE_LIMIT_ENABLED: 'false' });
    expect(config).toMatchObject({ APP_API_HOST: '0.0.0.0', APP_API_PORT: 9000, APP_TRUST_PROXY: 1, APP_BODY_LIMIT_BYTES: 2048, APP_AUTH_LOGIN_MAX: 3, APP_AUTH_RATE_LIMIT_ENABLED: false });
    expect(authLimitSettings(config).login).toEqual({ limit: 3, windowMs: 600_000 });
    expect(authLimitSettings(config).enabled).toBe(false);
  });

  it('값이 빈 변수는 기본값으로 취급한다(.env.example 복사본)', () => {
    const config = parseServerConfig({ ...base, APP_API_HOST: '', APP_API_PORT: '  ', APP_TRUST_PROXY: '', APP_LOG_LEVEL: '', APP_AUTH_LOGIN_MAX: '' });
    expect(config).toMatchObject({ APP_API_HOST: '127.0.0.1', APP_API_PORT: 8000, APP_TRUST_PROXY: false, APP_LOG_LEVEL: 'info', APP_AUTH_LOGIN_MAX: 10 });
    expect(() => parseAdminConfig({ ...base, APP_SUPABASE_SERVICE_KEY: '' })).toThrow(/APP_SUPABASE_SERVICE_KEY/);
  });

  it('일반 서버 설정에는 서비스 키와 관리자 목록이 들어오지 않는다', () => {
    const config = parseServerConfig({ ...base, APP_SUPABASE_SERVICE_KEY: 'service-secret', APP_PLATFORM_ADMIN_USER_IDS: 'x' });
    expect(config).not.toHaveProperty('APP_SUPABASE_SERVICE_KEY');
    expect(config).not.toHaveProperty('APP_PLATFORM_ADMIN_USER_IDS');
    expect(JSON.stringify(config)).not.toContain('service-secret');
  });

  it('잘못된 값은 변수 이름만 알리고 거부한다', () => {
    expect(() => parseServerConfig({ ...base, APP_API_PORT: '0' })).toThrow(/APP_API_PORT/);
    expect(() => parseServerConfig({ ...base, APP_TRUST_PROXY: 'not an ip!' })).toThrow(/APP_TRUST_PROXY/);
    expect(() => parseServerConfig({ ...base, APP_LOG_LEVEL: 'loud' })).toThrow(/APP_LOG_LEVEL/);
  });
});

describe('parseTrustProxy', () => {
  it('false/true/홉 수/CIDR 목록을 해석한다', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('TRUE')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('127.0.0.1, 10.0.0.0/8')).toEqual(['127.0.0.1', '10.0.0.0/8']);
  });
});

describe('parseAdminConfig', () => {
  it('서비스 키가 필수이고 기본 포트는 8001, 127.0.0.1 바인딩이다', () => {
    expect(() => parseAdminConfig(base)).toThrow(/APP_SUPABASE_SERVICE_KEY/);
    const config = parseAdminConfig({ ...base, APP_SUPABASE_SERVICE_KEY: 'service', APP_PLATFORM_ADMIN_USER_IDS: 'abc' });
    expect(config).toMatchObject({ APP_ADMIN_HOST: '127.0.0.1', APP_ADMIN_PORT: 8001, APP_PLATFORM_ADMIN_USER_IDS: 'abc' });
  });

  it('일반 API 와 같은 호스트·포트는 거부한다', () => {
    expect(() => parseAdminConfig({ ...base, APP_SUPABASE_SERVICE_KEY: 's', APP_ADMIN_PORT: '8000' })).toThrow(/APP_ADMIN_PORT/);
    expect(parseAdminConfig({ ...base, APP_SUPABASE_SERVICE_KEY: 's', APP_ADMIN_PORT: '8000', APP_ADMIN_HOST: '127.0.0.2' }).APP_ADMIN_PORT).toBe(8000);
  });
});
