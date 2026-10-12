export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
export interface HttpRequest { method: HttpMethod; path: string; headers: Record<string, string>; body?: string }
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
