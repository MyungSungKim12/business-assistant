export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
export interface HttpRequest { method: HttpMethod; path: string; headers: Record<string, string>; body?: string; /** 'admin'이면 일반 API가 아닌 관리자 API 서버로 보낸다. */ scope?: 'admin' }
export interface HttpResponse { status: number; body: string; headers: Record<string, string> }
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

export function fetchTransport(apiBase: string): HttpTransport {
  return async (request) => {
    const response = await fetch(joinUrl(apiBase, request.path), {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return { status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers.entries()) };
  };
}
