export class ApiFailure extends Error {
  /** headers: 응답에 그대로 실을 헤더(예: 429의 Retry-After). */
  constructor(public status: number, public detail: string, public extra: Record<string, unknown> = {}, public headers: Record<string, string> = {}) { super(detail); }
}
