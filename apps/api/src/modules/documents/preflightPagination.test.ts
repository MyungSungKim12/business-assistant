import { describe, expect, it } from 'vitest';
import { auth, build, DOCUMENT, event, issued, treatmentPath, TREATMENT } from './testkit.js';

describe('시술 전 확인용 문서·철회 이력 완전 조회', () => {
  it('서버 페이지가 1행이어도 마지막 철회까지 읽는다', async () => {
    const rows = [event, { ...event, id: DOCUMENT, revision: 2, action: 'revoke' }];
    const { app } = build({ respond: call => {
      if (call.url.pathname.endsWith('issued_treatment_documents')) return { body: [{ id: DOCUMENT }] };
      const offset = Number(call.url.searchParams.get('offset'));
      return { body: rows.slice(offset, offset + 1), headers: { 'Content-Range': `${offset}-${offset}/2` } };
    } });
    const response = await app.inject({ url: treatmentPath(`documents/${DOCUMENT}/events`), headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((row: { action: string }) => row.action)).toEqual(['sign', 'revoke']);
  });
  it('발행본 목록도 count를 확인하며 다른 고객·시술 응답을 거부한다', async () => {
    const { app } = build({ respond: call => {
      if (call.url.pathname.endsWith('treatment_records')) return { body: [{ id: TREATMENT }] };
      const offset = Number(call.url.searchParams.get('offset'));
      return { body: [{ ...issued, id: offset === 0 ? DOCUMENT : TREATMENT }], headers: { 'Content-Range': `${offset}-${offset}/2` } };
    } });
    const response = await app.inject({ url: treatmentPath(), headers: auth });
    expect(response.statusCode).toBe(200); expect(response.json()).toHaveLength(2);
    const denied = build({ respond: call => ({ body: call.url.pathname.endsWith('treatment_records') ? [{ id: TREATMENT }] : [{ ...issued, customer_id: TREATMENT }] }) });
    expect((await denied.app.inject({ url: treatmentPath(), headers: auth })).statusCode).toBe(503);
  });
  it('뒤쪽 페이지 실패를 서명만 있는 성공 이력으로 돌려주지 않는다', async () => {
    const { app } = build({ respond: call => {
      if (call.url.pathname.endsWith('issued_treatment_documents')) return { body: [{ id: DOCUMENT }] };
      return Number(call.url.searchParams.get('offset')) === 0 ? { body: [event], headers: { 'Content-Range': '0-0/2' } } : { status: 503, body: {} };
    } });
    expect((await app.inject({ url: treatmentPath(`documents/${DOCUMENT}/events`), headers: auth })).statusCode).toBe(503);
  });
});
