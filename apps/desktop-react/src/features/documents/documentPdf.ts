import type { ApiClient } from '../../api/client';
import { renderPdf, savePdf, sha256Hex, type PdfSection, type PdfSpec } from '../../lib/pdf';
import { documentApi } from './api';
import { formatTime } from './errors';
import { consentActionLabel, deliveryMethodLabel, documentStatusLabel, type ConsentEvent, type DocumentRecord, type IssuedDocument, type Scope } from './schemas';
import type { Strokes } from './signature';

const text = (value: unknown, fallback = '미등록') => (typeof value === 'string' && value.trim() ? value : fallback);

/** 발행 당시 고객·시술 요약(서버가 보관한 source_snapshot 기준). */
function sourceRows(snapshot: IssuedDocument['source_snapshot']): Array<[string, string]> {
  const { customer, treatment } = snapshot as { customer?: Record<string, unknown>; treatment?: Record<string, unknown> };
  if (!customer || typeof customer !== 'object' || !treatment || typeof treatment !== 'object') return [];
  return [
    ['고객', `${text(customer.name)} · 연락처 ${text(customer.phone)}`],
    ['시술', `${text(treatment.name)} · 시술일 ${text(treatment.date)}`],
  ];
}

export type ConsentStatus = 'unsigned' | 'signed' | 'revoked';
export const consentStatusText: Record<ConsentStatus, string> = { unsigned: '서명 미확인', signed: '현장 손서명 기록됨 (별도 본인인증 미수행)', revoked: '철회됨 (원문·손서명 보존)' };

export function consentStatusOf(events: ConsentEvent[]): ConsentStatus {
  if (events.some((event) => event.action === 'revoke')) return 'revoked';
  return events.some((event) => event.action === 'sign') ? 'signed' : 'unsigned';
}

/** 발행본 원문 해시(앱에서 계산). 제목·본문·서식 버전이 같으면 항상 같은 값이다. */
export function documentContentHash(document: Pick<IssuedDocument, 'title' | 'content' | 'template_version'>): string {
  return sha256Hex(`${document.title}\n${document.template_version}\n${document.content}`);
}

/**
 * PDF 한 장을 식별하는 짧은 검증 코드. 발행본 ID·원문 해시와 모든 이벤트의 증빙 해시(없으면 DB 내용 해시)를 묶어 계산하므로,
 * 이력이 하나라도 달라지면 코드가 바뀐다. 형식: XXXX-XXXX-XXXX-XXXX.
 */
export function verificationCode(document: IssuedDocument, events: ConsentEvent[]): string {
  const lines = ['verification-v1', document.id, documentContentHash(document), ...events.map((event) => `${event.revision}:${event.action}:${event.evidence?.hash ?? event.content_hash}`)];
  const digest = sha256Hex(lines.join('\n')).slice(0, 16).toUpperCase();
  return digest.match(/.{4}/g)!.join('-');
}

function eventRows(events: ConsentEvent[]): Array<[string, string]> {
  return events.map((event) => {
    const lines = [`기록 시각(서버) ${formatTime(event.occurred_at)}`, `기록자 ID ${event.actor_id}`, `내용 해시 ${event.content_hash}`];
    lines.push(event.evidence ? `증빙 해시 ${event.evidence.hash}\n해시 방식 ${event.evidence.algorithm}` : '증빙 해시 없음 (증빙 기능 적용 이전 기록)');
    const values = event.values as Record<string, unknown>;
    if (event.action === 'deliver') lines.push(`교부 ${deliveryMethodLabel[String(values.method)] ?? text(values.method)} · 수령인 ${text(values.recipient)}`);
    if (event.action === 'revoke') lines.push(`철회 사유 ${text(values.reason)}`);
    return [`${event.revision}. ${consentActionLabel[event.action]}`, lines.join('\n')];
  });
}

function stateRows(events: ConsentEvent[]): Array<[string, string]> {
  const status = consentStatusOf(events);
  const signed = events.find((event) => event.action === 'sign');
  const rows: Array<[string, string]> = [['동의 상태', consentStatusText[status]]];
  if (signed) rows.push(['서명자', text((signed.values as { signer_name?: unknown }).signer_name)], ['서명 시각(서버)', formatTime(signed.occurred_at)]);
  rows.push(['교부 확인', `${events.filter((event) => event.action === 'deliver').length}건`]);
  const revoked = events.find((event) => event.action === 'revoke');
  if (revoked) rows.push(['철회 시각(서버)', formatTime(revoked.occurred_at)]);
  return rows;
}

/** 시술 문서 발행본 + 서명·교부·철회 이력과 증빙 해시를 담은 PDF 설명. */
export function buildConsentPdfSpec(document: IssuedDocument, events: ConsentEvent[], now: Date = new Date()): PdfSpec {
  const code = verificationCode(document, events);
  const sections: PdfSection[] = [
    { kind: 'heading', text: '발행 정보' },
    { kind: 'rows', rows: [
      ['발행 시각', formatTime(document.issued_at)], ['발행자 ID', document.issued_by], ['서식 버전', `v${document.template_version}`], ['발행본 ID', document.id],
      ...sourceRows(document.source_snapshot),
    ] },
    { kind: 'heading', text: '문서 내용' },
    { kind: 'paragraph', text: document.content },
    { kind: 'heading', text: '동의 상태' },
    { kind: 'rows', rows: stateRows(events) },
  ];
  const signed = events.find((event) => event.action === 'sign');
  if (signed) {
    const values = signed.values as { signer_name?: unknown; strokes?: unknown };
    const strokes = Array.isArray(values.strokes) ? (values.strokes as Strokes) : [];
    sections.push({ kind: 'signature', label: '손서명', strokes, caption: `서명자 ${text(values.signer_name)} · 서버 기록 시각 ${formatTime(signed.occurred_at)} · 현장 손서명(별도 본인인증 미수행)` });
  }
  sections.push(
    { kind: 'heading', text: '증빙 이력' },
    events.length > 0 ? { kind: 'rows', rows: eventRows(events) } : { kind: 'paragraph', text: '아직 서명·교부·철회 기록이 없습니다.', muted: true },
    { kind: 'heading', text: '검증' },
    { kind: 'rows', rows: [['검증 코드', code], ['원문 해시(SHA-256)', documentContentHash(document)]] },
    { kind: 'paragraph', muted: true, text: '이 문서는 발행 당시의 내용과 서버가 기록한 시각·증빙 해시를 담고 있습니다. 앱의 발행본 · 서명·교부·철회 창에서 각 기록의 무결성 확인으로 서버 기록과 일치하는지 다시 확인할 수 있습니다.' },
  );
  return { title: document.title, subtitle: `시술 문서 발행본 · 서식 v${document.template_version}`, sections, footer: `검증 코드 ${code} · ${formatTime(now.toISOString())} 생성`, createdAt: now };
}

/** 일반 문서(제목·본문·상태)를 담은 PDF 설명. */
export function buildDocumentPdfSpec(document: Pick<DocumentRecord, 'title' | 'content' | 'status' | 'updated_at'>, now: Date = new Date()): PdfSpec {
  const code = sha256Hex(`document-v1\n${document.title}\n${document.content}`).slice(0, 16).toUpperCase().match(/.{4}/g)!.join('-');
  return {
    title: document.title,
    subtitle: `${documentStatusLabel[document.status] ?? document.status} · 수정 ${formatTime(document.updated_at)}`,
    sections: [{ kind: 'paragraph', text: document.content }],
    footer: `내용 코드 ${code} · ${formatTime(now.toISOString())} 생성`,
    createdAt: now,
  };
}

/** 이력을 최신으로 읽어(이미 읽었다면 그 목록을 사용) PDF 를 만들고 저장한다. 저장하면 true, 저장 대화상자를 취소하면 false. */
export async function exportConsentPdf(api: ApiClient, scope: Scope, document: IssuedDocument, knownEvents?: ConsentEvent[]): Promise<boolean> {
  const events = knownEvents ?? await documentApi.listEvents(api, scope, document.id);
  const bytes = await renderPdf(buildConsentPdfSpec(document, events));
  return savePdf(`${document.title}_발행본`, bytes);
}

export async function exportDocumentPdf(document: Pick<DocumentRecord, 'title' | 'content' | 'status' | 'updated_at'>): Promise<boolean> {
  const bytes = await renderPdf(buildDocumentPdfSpec(document));
  return savePdf(document.title, bytes);
}
