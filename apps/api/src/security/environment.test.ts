import { describe, expect, it } from 'vitest';
import { bindWarning, inspectEnvironment, scrubEnvironment } from './environment.js';

describe('inspectEnvironment (SEC-05 개발용 자동 로그인 차단)', () => {
  it('production 에서 BUSINESS_ASSISTANT_DEV_AUTO_LOGIN 이 켜져 있으면 시작을 거부한다', () => {
    for (const value of ['true', '1', 'YES', 'on']) {
      const report = inspectEnvironment({ NODE_ENV: 'production', BUSINESS_ASSISTANT_DEV_AUTO_LOGIN: value }, 'api');
      expect(report.errors, value).toHaveLength(1);
    }
    expect(inspectEnvironment({ APP_ENVIRONMENT: 'production', BUSINESS_ASSISTANT_DEV_AUTO_LOGIN: 'true' }, 'admin').errors).toHaveLength(1);
  });

  it('오류 메시지는 변수 이름만 담고 값(계정·비밀번호)은 담지 않는다', () => {
    const report = inspectEnvironment({ NODE_ENV: 'production', BUSINESS_ASSISTANT_DEV_AUTO_LOGIN: 'true', BUSINESS_ASSISTANT_DEV_EMAIL: 'me@example.com', BUSINESS_ASSISTANT_DEV_PASSWORD: 'p@ss-secret' }, 'api');
    const text = [...report.errors, ...report.warnings].join('\n');
    expect(text).not.toContain('me@example.com');
    expect(text).not.toContain('p@ss-secret');
    expect(report.warnings.some((message) => message.includes('BUSINESS_ASSISTANT_DEV_PASSWORD'))).toBe(true);
  });

  it('개발 환경이나 꺼진 값은 거부하지 않는다', () => {
    expect(inspectEnvironment({ BUSINESS_ASSISTANT_DEV_AUTO_LOGIN: 'true' }, 'api').errors).toEqual([]);
    expect(inspectEnvironment({ NODE_ENV: 'production', BUSINESS_ASSISTANT_DEV_AUTO_LOGIN: 'false' }, 'api').errors).toEqual([]);
    expect(inspectEnvironment({ NODE_ENV: 'production' }, 'api')).toEqual({ errors: [], warnings: [] });
  });

  it('일반 API 는 서비스 키가 환경에 있으면 경고하고, 관리자 서버는 경고하지 않는다', () => {
    const environment = { APP_SUPABASE_SERVICE_KEY: 'service-secret', APP_PLATFORM_ADMIN_USER_IDS: 'x' };
    const api = inspectEnvironment(environment, 'api');
    expect(api.warnings).toHaveLength(2);
    expect(api.warnings.join('\n')).not.toContain('service-secret');
    expect(inspectEnvironment(environment, 'admin').warnings).toEqual([]);
  });
});

describe('scrubEnvironment', () => {
  it('일반 API 는 서비스 키와 개발용 계정을 환경에서 지우고 관리자는 서비스 키를 유지한다', () => {
    const api: Record<string, string | undefined> = { APP_SUPABASE_SERVICE_KEY: 's', APP_PLATFORM_ADMIN_USER_IDS: 'x', BUSINESS_ASSISTANT_DEV_PASSWORD: 'p', APP_SUPABASE_URL: 'u' };
    scrubEnvironment(api, 'api');
    expect(api).toEqual({ APP_SUPABASE_URL: 'u' });
    const admin: Record<string, string | undefined> = { APP_SUPABASE_SERVICE_KEY: 's', BUSINESS_ASSISTANT_DEV_PASSWORD: 'p' };
    scrubEnvironment(admin, 'admin');
    expect(admin).toEqual({ APP_SUPABASE_SERVICE_KEY: 's' });
  });
});

describe('bindWarning', () => {
  it('루프백은 경고하지 않고 0.0.0.0 등 외부 노출 주소는 경고한다', () => {
    expect(bindWarning('127.0.0.1')).toBeNull();
    expect(bindWarning('localhost')).toBeNull();
    expect(bindWarning('::1')).toBeNull();
    expect(bindWarning('0.0.0.0')).toContain('0.0.0.0');
    expect(bindWarning('192.168.0.5')).not.toBeNull();
  });
});
