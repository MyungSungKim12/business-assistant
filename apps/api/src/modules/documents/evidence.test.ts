import { describe, expect, it } from 'vitest';
import { canonicalJson, computeEvidenceHash, EVIDENCE_ALGORITHM, verifyEvidence, type EvidenceInput } from './evidence.js';
import { auth, build, DOCUMENT, event, expectNoLeak, ORG, OPERATION, sign, treatmentPath, USER } from './testkit.js';

const base: EvidenceInput = {
  organization_id: ORG, document_id: DOCUMENT, event_id: OPERATION, revision: 1, action: 'sign', content_hash: 'a'.repeat(64),
  values: { signer_name: '고객', strokes: [[[0, 0], [1, 1]]], confirmed: true }, actor_id: USER, occurred_at: '2030-01-01T00:00:00.123456+00:00',
};

describe('증빙 해시 계산', () => {
  it('키 순서와 공백에 상관없이 같은 정규화 JSON 을 만든다', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe('{"a":{"c":null,"d":[1,2]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('64자리 소문자 16진수이고 같은 입력이면 항상 같다', () => {
    const hash = computeEvidenceHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEvidenceHash({ ...base, values: { confirmed: true, strokes: [[[0, 0], [1, 1]]], signer_name: '고객' } })).toBe(hash);
  });

  it.each([
    ['서명 데이터', { values: { ...base.values, strokes: [[[0, 0], [1, 0.9]]] } }],
    ['서명자 ID', { actor_id: '29cc39fd-8e8c-4df8-a623-1f23a3a936bd' }],
    ['서버 시각', { occurred_at: '2030-01-01T00:00:01+00:00' }],
    ['문서 내용 해시', { content_hash: 'b'.repeat(64) }],
    ['동작', { action: 'revoke' }],
    ['순번', { revision: 2 }],
    ['문서 ID', { document_id: '39cc39fd-8e8c-4df8-a623-1f23a3a936bd' }],
  ])('%s 가 바뀌면 해시가 달라진다', (_name, change) => {
    expect(computeEvidenceHash({ ...base, ...change })).not.toBe(computeEvidenceHash(base));
  });

  it('저장값과 같으면 match, 다르면 mismatch, 없으면 no_proof, 모르는 알고리즘은 unknown_algorithm', () => {
    const hash = computeEvidenceHash(base);
    expect(verifyEvidence(base, { algorithm: EVIDENCE_ALGORITHM, hash })).toMatchObject({ status: 'match', computed_hash: hash, stored_hash: hash });
    expect(verifyEvidence({ ...base, revision: 2 }, { algorithm: EVIDENCE_ALGORITHM, hash })).toMatchObject({ status: 'mismatch', stored_hash: hash });
    expect(verifyEvidence(base, null)).toMatchObject({ status: 'no_proof', stored_hash: null, computed_hash: null });
    expect(verifyEvidence(base, { algorithm: 'md5', hash })).toMatchObject({ status: 'unknown_algorithm', computed_hash: null });
  });
});

const eventsPath = treatmentPath(`documents/${DOCUMENT}/events`);
const respond = (rows: unknown[]) => (call: { url: URL }) => ({ body: call.url.pathname.endsWith('issued_treatment_documents') ? [{ id: DOCUMENT }] : rows });
const stored = (row: typeof event) => computeEvidenceHash({ ...row, event_id: row.id } as EvidenceInput);

describe('증빙 저장·조회·검증 API', () => {
  it('기록 직후 서버가 해시를 계산해 증빙 표에 중복 무시로 저장하고 응답에 싣는다', async () => {
    const { app, calls } = build({ respond: (call) => (call.url.pathname.endsWith('/rpc/record_treatment_document_event') ? { body: [event] } : { body: null }) });
    const result = await app.inject({ method: 'POST', url: eventsPath, headers: auth, payload: { expected_revision: 0, operation_id: OPERATION, action: 'sign', values: sign } });
    expect(result.statusCode).toBe(201);
    const expected = stored(event);
    expect(result.json().evidence).toEqual({ algorithm: EVIDENCE_ALGORITHM, hash: expected });
    expectNoLeak(result.body);
    const proof = calls[1];
    expect(proof.method).toBe('POST');
    expect(proof.url.pathname).toBe('/rest/v1/treatment_document_event_proofs');
    expect(proof.url.searchParams.get('on_conflict')).toBe('event_id');
    expect(proof.headers.Prefer).toBe('resolution=ignore-duplicates,return=minimal');
    expect(proof.body).toEqual({ event_id: event.id, organization_id: ORG, document_id: DOCUMENT, algorithm: EVIDENCE_ALGORITHM, evidence_hash: expected });
  });

  it('증빙 저장이 실패해도 확정된 이벤트는 그대로 돌려주고 evidence 는 null', async () => {
    const { app } = build({ respond: (call) => (call.url.pathname.endsWith('/rpc/record_treatment_document_event') ? { body: [event] } : { status: 500, body: { message: 'private' } }) });
    const result = await app.inject({ method: 'POST', url: eventsPath, headers: auth, payload: { expected_revision: 0, operation_id: OPERATION, action: 'sign', values: sign } });
    expect(result.statusCode).toBe(201);
    expect(result.json().evidence).toBeNull();
    expect(result.body).not.toContain('private');
  });

  it('이력 조회는 증빙을 함께 임베드해 읽고 evidence 로 내려 준다(없으면 null)', async () => {
    const withProof = { ...event, proof: { algorithm: EVIDENCE_ALGORITHM, evidence_hash: 'c'.repeat(64) } };
    const legacy = { ...event, id: '49cc39fd-8e8c-4df8-a623-1f23a3a936bd', revision: 2, action: 'deliver', proof: null };
    const { app, calls } = build({ respond: respond([withProof, legacy]) });
    const result = await app.inject({ url: eventsPath, headers: auth });
    expect(result.statusCode).toBe(200);
    expect(calls[1].url.searchParams.get('select')).toContain('treatment_document_event_proofs');
    const [first, second] = result.json();
    expect(first.evidence).toEqual({ algorithm: EVIDENCE_ALGORITHM, hash: 'c'.repeat(64) });
    expect(second.evidence).toBeNull();
    expect(first).not.toHaveProperty('proof');
  });

  it('검증: 저장된 해시와 다시 계산한 값이 같으면 match', async () => {
    const row = { ...event, proof: { algorithm: EVIDENCE_ALGORITHM, evidence_hash: stored(event) } };
    const { app, calls } = build({ role: 'member', respond: respond([row]) });
    const result = await app.inject({ url: `${eventsPath}/${event.id}/verify`, headers: auth });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ status: 'match', event_id: event.id, revision: 1, stored_hash: stored(event), computed_hash: stored(event) });
    expect(calls[1].url.searchParams.get('id')).toBe(`eq.${event.id}`);
    expect(calls[1].url.searchParams.get('document_id')).toBe(`eq.${DOCUMENT}`);
  });

  it('검증: 이벤트 내용이 저장 이후 달라졌다면 mismatch', async () => {
    const tampered = { ...event, values: { ...sign, signer_name: 'Someone Else' }, proof: { algorithm: EVIDENCE_ALGORITHM, evidence_hash: stored(event) } };
    const result = await build({ respond: respond([tampered]) }).app.inject({ url: `${eventsPath}/${event.id}/verify`, headers: auth });
    expect(result.json().status).toBe('mismatch');
    expect(result.json().computed_hash).not.toBe(result.json().stored_hash);
  });

  it('검증: 증빙이 없던 옛 이벤트는 no_proof', async () => {
    const result = await build({ respond: respond([{ ...event, proof: null }]) }).app.inject({ url: `${eventsPath}/${event.id}/verify`, headers: auth });
    expect(result.json()).toMatchObject({ status: 'no_proof', stored_hash: null });
  });

  it('검증: 이벤트가 없으면 404, 식별자가 잘못되면 422, 권한·기능이 없으면 403', async () => {
    expect((await build({ respond: respond([]) }).app.inject({ url: `${eventsPath}/${event.id}/verify`, headers: auth })).statusCode).toBe(404);
    expect((await build().app.inject({ url: `${eventsPath}/not-a-uuid/verify`, headers: auth })).statusCode).toBe(422);
    expect((await build({ features: ['crm.basic'] }).app.inject({ url: `${eventsPath}/${event.id}/verify`, headers: auth })).statusCode).toBe(403);
    expect((await build().app.inject({ url: `${eventsPath}/${event.id}/verify` })).statusCode).toBe(401);
  });

  it('검증: 다른 이벤트를 돌려주면 안전한 503', async () => {
    const other = { ...event, id: '49cc39fd-8e8c-4df8-a623-1f23a3a936bd', proof: null };
    expect((await build({ respond: respond([other]) }).app.inject({ url: `${eventsPath}/${event.id}/verify`, headers: auth })).statusCode).toBe(503);
  });
});
