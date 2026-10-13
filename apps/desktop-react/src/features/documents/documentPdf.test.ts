import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPdf } from '../../lib/pdf/buildPdf';
import { buildConsentPdfSpec, buildDocumentPdfSpec, consentStatusOf, documentContentHash, verificationCode } from './documentPdf';
import type { ConsentEvent } from './schemas';
import { document, issued, signEvent } from './testkit';

const fontDir = resolve(import.meta.dirname, '../../assets/fonts');
const fonts = { regular: new Uint8Array(readFileSync(resolve(fontDir, 'SUIT-Regular.ttf'))), bold: new Uint8Array(readFileSync(resolve(fontDir, 'SUIT-Bold.ttf'))) };
const now = new Date('2026-10-13T03:00:00Z');

const signed: ConsentEvent = { ...signEvent, evidence: { algorithm: 'sha256-canonical-json-v1', hash: 'e'.repeat(64) } };
const delivered: ConsentEvent = { ...signEvent, id: '99999999-9999-4999-8999-999999999999', revision: 2, action: 'deliver', values: { method: 'email', recipient: '김고객', reference: '', note: '', confirmed: true }, evidence: null };
const revoked: ConsentEvent = { ...signEvent, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 3, action: 'revoke', values: { reason: '고객 요청', confirmed: true }, evidence: null };

describe('동의 상태·해시', () => {
  it('상태는 철회 > 서명 > 미서명 순으로 정한다', () => {
    expect(consentStatusOf([])).toBe('unsigned');
    expect(consentStatusOf([signed])).toBe('signed');
    expect(consentStatusOf([signed, delivered, revoked])).toBe('revoked');
  });

  it('원문 해시는 제목·본문·서식 버전이 같으면 같고, 하나라도 다르면 달라진다', () => {
    const base = documentContentHash(issued);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(documentContentHash({ ...issued })).toBe(base);
    expect(documentContentHash({ ...issued, content: `${issued.content}!` })).not.toBe(base);
    expect(documentContentHash({ ...issued, template_version: 3 })).not.toBe(base);
  });

  it('검증 코드는 XXXX-XXXX-XXXX-XXXX 형식이고 이력이 바뀌면 달라진다', () => {
    const code = verificationCode(issued, [signed]);
    expect(code).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect(verificationCode(issued, [signed])).toBe(code);
    expect(verificationCode(issued, [signed, delivered])).not.toBe(code);
    expect(verificationCode(issued, [{ ...signed, evidence: { algorithm: 'sha256-canonical-json-v1', hash: 'f'.repeat(64) } }])).not.toBe(code);
    expect(verificationCode(issued, [])).not.toBe(code);
  });
});

describe('buildConsentPdfSpec', () => {
  const textOf = (spec: ReturnType<typeof buildConsentPdfSpec>) => JSON.stringify(spec.sections);

  it('발행 정보·본문·동의 상태·서명·증빙 해시·검증 코드를 모두 담는다', () => {
    const spec = buildConsentPdfSpec(issued, [signed, delivered], now);
    const text = textOf(spec);
    expect(spec.title).toBe(issued.title);
    expect(text).toContain(issued.content);
    expect(text).toContain(`v${issued.template_version}`);
    expect(text).toContain(issued.issued_by);
    expect(text).toContain('김고객');
    expect(text).toContain('e'.repeat(64));
    expect(text).toContain(signed.content_hash);
    expect(text).toContain('현장 손서명 기록됨');
    expect(text).toContain('증빙 해시 없음');
    const signature = spec.sections.find((section) => section.kind === 'signature');
    expect(signature).toMatchObject({ kind: 'signature', strokes: [[[0, 0], [1, 1]]] });
    expect(spec.footer).toContain(verificationCode(issued, [signed, delivered]));
    expect(text).toContain(verificationCode(issued, [signed, delivered]));
  });

  it('서명이 없으면 서명 구역 없이 미서명 상태와 빈 이력 안내를 담는다', () => {
    const spec = buildConsentPdfSpec(issued, [], now);
    expect(spec.sections.some((section) => section.kind === 'signature')).toBe(false);
    expect(textOf(spec)).toContain('서명 미확인');
    expect(textOf(spec)).toContain('아직 서명·교부·철회 기록이 없습니다.');
  });

  it('철회된 문서는 철회 상태와 사유를 보존한다', () => {
    const text = textOf(buildConsentPdfSpec(issued, [signed, revoked], now));
    expect(text).toContain('철회됨');
    expect(text).toContain('고객 요청');
    expect(text).toContain('손서명');
  });

  it('실제 폰트로 올바른 PDF 가 만들어진다(서명 포함)', async () => {
    const bytes = await buildPdf(buildConsentPdfSpec(issued, [signed, delivered, revoked], now), fonts);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(5000);
  });
});

describe('buildDocumentPdfSpec', () => {
  it('제목·본문·상태를 담고 내용 코드를 바닥글에 넣는다', () => {
    const spec = buildDocumentPdfSpec(document, now);
    expect(spec.title).toBe(document.title);
    expect(spec.subtitle).toContain('초안');
    expect(JSON.stringify(spec.sections)).toContain(document.content);
    expect(spec.footer).toMatch(/내용 코드 [0-9A-F]{4}(-[0-9A-F]{4}){3}/);
  });
});
