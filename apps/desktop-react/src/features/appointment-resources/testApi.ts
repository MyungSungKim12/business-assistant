import type { z } from 'zod';
import { vi } from 'vitest';
import { ApiError } from '../../api/errors';
import type { CallApi } from './api';

export type FakeCall = { method: string; path: string; body?: unknown };
export type FakeHandler = (call: FakeCall) => unknown;

/**
 * 테스트용 가짜 ApiClient. handler가 돌려준 값을 실제 응답처럼 zod 스키마로 검증해서 돌려주므로
 * 서버 응답 형식이 바뀌면 테스트도 깨진다. handler가 ApiError를 던지면 그대로 전달된다.
 */
export function fakeApi(handler: FakeHandler) {
  const calls: FakeCall[] = [];
  const call = vi.fn(async (method: string, path: string, schema: z.ZodType, body?: unknown) => {
    const entry = { method, path, body };
    calls.push(entry);
    return schema.parse(await handler(entry));
  });
  const callVoid = vi.fn(async (method: string, path: string, body?: unknown) => { calls.push({ method, path, body }); await handler({ method, path, body }); });
  return { api: { call, callVoid } as unknown as CallApi & { callVoid: typeof callVoid }, calls, call };
}
export const apiFailure = (status: number, message = '실패') => new ApiError(status, `HTTP_${status}`, message, status >= 500);
