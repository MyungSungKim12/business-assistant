/**
 * Python 어댑터(`_request`)와 같이 PostgreSQL 오류 코드로 상태를 정하기 위한 fetch 감싸개.
 * PostgREST는 `raise exception ... using errcode`를 400 + `{code}`로 돌려준다. createRest는 400을 422로만
 * 취급하므로, 코드가 있으면 HTTP 상태를 아래 표대로 바꿔 createRest의 상태 매핑(409/404/403/422)이 동작하게 한다.
 *   P0001·23505 → 409(충돌·낙관적 잠금·멱등 키 불일치), P0002 → 404, 42501 → 403, 22023·23514·22P02 → 422
 * 응답 본문은 createRest가 읽고 클라이언트에 그대로 노출하지 않는다.
 */
const codeStatus: Record<string, number> = { P0001: 409, '23505': 409, P0002: 404, '42501': 403, '22023': 422, '23514': 422, '22P02': 422 };

export function withPgErrorMap(fetcher: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetcher(input, init);
    if (response.ok) return response;
    let code: unknown;
    try { code = (JSON.parse(await response.clone().text()) as { code?: unknown } | null)?.code; } catch { code = undefined; }
    const status = typeof code === 'string' ? codeStatus[code] : undefined;
    if (!status || status === response.status) return response;
    return new Response(await response.text(), { status, headers: response.headers });
  }) as typeof fetch;
}
