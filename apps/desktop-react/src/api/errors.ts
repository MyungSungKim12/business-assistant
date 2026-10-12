export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiError(status: number, body: string): ApiError {
  let detail = '';
  let code = `HTTP_${status}`;
  let requestId: string | undefined;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; code?: unknown; request_id?: unknown };
    if (typeof parsed.detail === 'string') detail = parsed.detail;
    if (typeof parsed.code === 'string') code = parsed.code;
    if (typeof parsed.request_id === 'string') requestId = parsed.request_id;
  } catch { /* use HTTP fallback */ }
  return new ApiError(status, code, detail || `요청에 실패했습니다. (${status})`, status === 0 || status === 408 || status === 429 || status >= 500, requestId);
}
