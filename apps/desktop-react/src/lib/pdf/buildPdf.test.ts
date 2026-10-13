import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPdf, drawSignatureStrokes } from './buildPdf';
import type { PdfFonts, PdfSpec } from './types';

const fontDir = resolve(import.meta.dirname, '../../assets/fonts');
const fonts: PdfFonts = {
  regular: new Uint8Array(readFileSync(resolve(fontDir, 'SUIT-Regular.ttf'))),
  bold: new Uint8Array(readFileSync(resolve(fontDir, 'SUIT-Bold.ttf'))),
};
const createdAt = new Date('2026-10-13T01:02:03Z');
const header = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 8));

async function loadDocument(bytes: Uint8Array) {
  const { PDFDocument } = await import('pdf-lib');
  return PDFDocument.load(bytes, { updateMetadata: false });
}

const baseSpec = (sections: PdfSpec['sections']): PdfSpec => ({
  title: '시술 동의서', subtitle: '서식 v2', sections, footer: '검증 코드 ABCD-1234', createdAt, author: '김원장',
});

describe('buildPdf', () => {
  it('한글 제목·본문·목록·서명을 담은 올바른 PDF 를 만든다', async () => {
    const bytes = await buildPdf(baseSpec([
      { kind: 'heading', text: '발행 정보' },
      { kind: 'rows', rows: [['발행자', '김원장'], ['증빙 해시', 'a'.repeat(64)]] },
      { kind: 'paragraph', text: '안녕하세요 김고객님.\n시술 전 주의사항을 안내드립니다.' },
      { kind: 'signature', label: '손서명', caption: '서명자 김고객', strokes: [[[0.1, 0.5], [0.4, 0.2], [0.9, 0.8]], [[0.5, 0.5]]] },
      { kind: 'spacer' },
    ]), fonts);
    expect(header(bytes)).toContain('%PDF-');
    expect((await loadDocument(bytes)).getPageCount()).toBe(1);
    // 글꼴은 부분 임베딩이라 원본(약 1.2MB)보다 훨씬 작아야 한다.
    expect(bytes.length).toBeGreaterThan(2000);
    expect(bytes.length).toBeLessThan(400_000);
  });

  it('긴 본문은 여러 쪽으로 나뉜다', async () => {
    const paragraph = '시술 후 일주일 동안 자외선 차단제를 바르고 사우나를 피하세요. '.repeat(260);
    const bytes = await buildPdf(baseSpec([{ kind: 'heading', text: '본문' }, { kind: 'paragraph', text: paragraph }]), fonts);
    expect((await loadDocument(bytes)).getPageCount()).toBeGreaterThan(2);
  });

  it('공백 없는 아주 긴 한글 문단과 이모지·제어 문자도 오류 없이 만든다', async () => {
    const bytes = await buildPdf(baseSpec([{ kind: 'paragraph', text: `${'가'.repeat(3000)}\u0000 😀 end` }]), fonts);
    expect(header(bytes)).toContain('%PDF-');
  });

  it('내용이 없어도 한 쪽짜리 PDF 가 된다', async () => {
    expect((await loadDocument(await buildPdf(baseSpec([]), fonts))).getPageCount()).toBe(1);
  });

  it('문서 정보에 제목·작성자·생성 도구가 기록된다', async () => {
    const loaded = await loadDocument(await buildPdf(baseSpec([]), fonts));
    expect(loaded.getTitle()).toBe('시술 동의서');
    expect(loaded.getProducer()).toBe('Business Assistant');
    expect(loaded.getAuthor()).toBe('김원장');
  });
});

describe('drawSignatureStrokes', () => {
  const draw = (strokes: Array<Array<[number, number]>>) => {
    const lines: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }> = [];
    const dots: Array<{ x: number; y: number }> = [];
    const page = { drawLine: (options: (typeof lines)[number]) => lines.push(options), drawCircle: (options: { x: number; y: number }) => dots.push(options) };
    const context = { page, palette: { ink: 'ink' }, lib: { LineCapStyle: { Round: 1 } } } as never;
    const count = drawSignatureStrokes(context, strokes, { x: 100, top: 500, width: 200, height: 50 });
    return { lines, dots, count };
  };

  it('획의 점 사이마다 선 하나를 그리고 좌표를 상자 크기로 확대한다(y 는 위에서 아래)', () => {
    const { lines, count } = draw([[[0, 0], [0.5, 0.5], [1, 1]]]);
    expect(count).toBe(2);
    expect(lines[0].start).toEqual({ x: 100, y: 500 });
    expect(lines[0].end).toEqual({ x: 200, y: 475 });
    expect(lines[1].end).toEqual({ x: 300, y: 450 });
  });

  it('한 점짜리 획은 점으로 그리고 범위를 벗어난 좌표는 상자 안으로 맞춘다', () => {
    const { lines, dots } = draw([[[0.5, 0.5]], [[-1, 2], [2, -1]]]);
    expect(dots).toHaveLength(1);
    expect(lines[0].start).toEqual({ x: 100, y: 450 });
    expect(lines[0].end).toEqual({ x: 300, y: 500 });
  });
});
