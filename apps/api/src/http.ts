import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ServerConfig, TrustProxy } from './config.js';
import { ApiFailure } from './errors.js';

const SENSITIVE_QUERY_KEY = /token|secret|passw|key|signature|sig|code|auth|jwt|session|cookie/i;

/** 로그에 남길 URL: 경로는 그대로, 민감해 보이는 쿼리 값은 [REDACTED] 로 바꾼다. */
export function redactUrl(url: string): string {
  const index = url.indexOf('?');
  if (index < 0) return url;
  const params = new URLSearchParams(url.slice(index + 1));
  const kept: string[] = [];
  for (const [name, value] of params) {
    kept.push(`${encodeURIComponent(name)}=${SENSITIVE_QUERY_KEY.test(name) ? '%5BREDACTED%5D' : encodeURIComponent(value)}`);
  }
  return kept.length ? `${url.slice(0, index)}?${kept.join('&')}` : url.slice(0, index);
}

/** 로그에서 값을 가리는 경로. 요청 헤더는 요청 직렬화에서 아예 빼지만, 직접 객체를 남기는 경우를 대비한다. */
export const REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers.apikey', 'res.headers["set-cookie"]',
  'password', 'access_token', 'refresh_token', 'token', 'authorization', 'cookie', 'apikey', 'service_key',
  '*.password', '*.access_token', '*.refresh_token', '*.token', '*.authorization', '*.cookie', '*.apikey', '*.service_key',
];

/** 숫자는 신뢰할 프록시 홉 수(Fastify 는 함수 형태로 받는다). */
export function fastifyTrustProxy(value: TrustProxy): boolean | string[] | ((address: string, hop: number) => boolean) {
  return typeof value === 'number' ? (_address, hop) => hop <= value : value;
}

export type HttpSettings = Pick<ServerConfig, 'APP_LOG_LEVEL' | 'APP_TRUST_PROXY' | 'APP_BODY_LIMIT_BYTES'>;

/** 일반 API와 관리자 API가 같이 쓰는 Fastify 생성(로그 redact, 프록시 신뢰, 본문 크기 제한, 보안 헤더, 오류 처리). */
export function createFastifyApp(settings: HttpSettings = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: settings.APP_LOG_LEVEL ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: {
        req(request: FastifyRequest) {
          return { method: request.method, url: redactUrl(request.url), host: request.host, remoteAddress: request.ip, remotePort: request.socket?.remotePort };
        },
      },
    },
    trustProxy: fastifyTrustProxy(settings.APP_TRUST_PROXY ?? false),
    bodyLimit: settings.APP_BODY_LIMIT_BYTES ?? 1_048_576,
  });
  installSecurityHeaders(app);
  installErrorHandler(app);
  return app;
}

/** helmet 없이 JSON API에 필요한 응답 헤더를 붙인다. 상태 확인(health)을 제외하고 캐시를 막는다. */
export function installSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (!reply.hasHeader('Cache-Control') && !request.url.startsWith('/api/v1/health')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }
    // HTTPS 로 들어온 요청(프록시 신뢰 시 X-Forwarded-Proto 기준)에만 HSTS 를 붙인다.
    if (request.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    return payload;
  });
}

const CLIENT_ERRORS: Record<number, string> = { 400: 'Bad request', 413: 'Payload too large', 415: 'Unsupported media type' };

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const failure = error instanceof ApiFailure ? error : undefined;
    const clientStatus = !failure && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : undefined;
    const status = failure ? failure.status : clientStatus ?? 500;
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
    if (failure) for (const [name, value] of Object.entries(failure.headers)) reply.header(name, value);
    // 원문 오류 메시지는 토큰·개인정보를 담을 수 있으므로 남기지 않고 종류만 기록한다.
    if (status >= 500) request.log.error({ status, errorName: error.name }, 'request failed');
    const detail = failure ? failure.detail : clientStatus ? CLIENT_ERRORS[clientStatus] ?? 'Bad request' : 'Internal server error';
    return reply.code(status).send({ detail, ...(failure ? failure.extra : {}), requestId: request.id });
  });
}
