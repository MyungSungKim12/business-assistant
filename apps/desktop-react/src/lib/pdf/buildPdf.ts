import type { Color, PDFDocument, PDFFont, PDFPage } from 'pdf-lib';
import { cachedMeasure, sanitizeText, wrapText } from './textLayout';
import type { PdfFonts, PdfSection, PdfSpec, PdfStroke } from './types';

// A4(포인트). 여백·글자 크기는 한 곳에서만 정한다.
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { left: 48, right: 48, top: 54, bottom: 56 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;
const SIZE = { title: 18, subtitle: 10, heading: 12, body: 10.5, row: 9.5, footer: 8 };
const LINE_HEIGHT = 1.5;
const LABEL_WIDTH = 104;
const SIGNATURE_BOX = { width: 320, height: 70 };
// 글자 너비 계산에는 커닝이 빠져 있으므로 줄 너비에 여유를 둔다.
const WIDTH_SAFETY = 0.98;

type Palette = { text: Color; muted: Color; line: Color; ink: Color };

type PdfLib = typeof import('pdf-lib');

type Context = {
  lib: PdfLib;
  doc: PDFDocument;
  regular: PDFFont;
  bold: PDFFont;
  page: PDFPage;
  y: number;
  palette: Palette;
};

function measureOf(font: PDFFont, size: number) {
  return cachedMeasure((text) => font.widthOfTextAtSize(text, size));
}

function addPage(context: Context): void {
  context.page = context.doc.addPage([PAGE.width, PAGE.height]);
  context.y = PAGE.height - MARGIN.top;
}

/** 필요한 높이가 남지 않으면 새 쪽으로 넘어간다. */
function ensureSpace(context: Context, height: number): void {
  if (context.y - height < MARGIN.bottom) addPage(context);
}

function drawLines(context: Context, lines: string[], font: PDFFont, size: number, x: number, color: Palette['text']): void {
  const step = size * LINE_HEIGHT;
  for (const line of lines) {
    ensureSpace(context, step);
    context.y -= step;
    if (line) context.page.drawText(line, { x, y: context.y + size * 0.3, size, font, color });
  }
}

function drawHeading(context: Context, text: string): void {
  ensureSpace(context, SIZE.heading * 3);
  context.y -= 8;
  drawLines(context, wrapText(text, CONTENT_WIDTH * WIDTH_SAFETY, measureOf(context.bold, SIZE.heading)), context.bold, SIZE.heading, MARGIN.left, context.palette.text);
  context.page.drawLine({ start: { x: MARGIN.left, y: context.y - 2 }, end: { x: PAGE.width - MARGIN.right, y: context.y - 2 }, thickness: 0.6, color: context.palette.line });
  context.y -= 6;
}

function drawParagraph(context: Context, text: string, muted: boolean): void {
  const lines = wrapText(text, CONTENT_WIDTH * WIDTH_SAFETY, measureOf(context.regular, SIZE.body));
  drawLines(context, lines, context.regular, SIZE.body, MARGIN.left, muted ? context.palette.muted : context.palette.text);
  context.y -= 4;
}

function drawRows(context: Context, rows: Array<[string, string]>): void {
  const valueWidth = (CONTENT_WIDTH - LABEL_WIDTH) * WIDTH_SAFETY;
  const labelMeasure = measureOf(context.bold, SIZE.row);
  const valueMeasure = measureOf(context.regular, SIZE.row);
  const step = SIZE.row * LINE_HEIGHT;
  for (const [label, value] of rows) {
    const labelLines = wrapText(label, (LABEL_WIDTH - 8) * WIDTH_SAFETY, labelMeasure);
    const valueLines = wrapText(value, valueWidth, valueMeasure);
    const count = Math.max(labelLines.length, valueLines.length);
    for (let index = 0; index < count; index += 1) {
      ensureSpace(context, step);
      context.y -= step;
      const baseline = context.y + SIZE.row * 0.3;
      if (labelLines[index]) context.page.drawText(labelLines[index], { x: MARGIN.left, y: baseline, size: SIZE.row, font: context.bold, color: context.palette.muted });
      if (valueLines[index]) context.page.drawText(valueLines[index], { x: MARGIN.left + LABEL_WIDTH, y: baseline, size: SIZE.row, font: context.regular, color: context.palette.text });
    }
    context.y -= 2;
  }
  context.y -= 2;
}

/** 서명 획을 상자 안에 선으로 그린다(0~1 좌표를 상자 크기로 확대, y 는 위에서 아래). 한 점짜리 획은 작은 점. */
export function drawSignatureStrokes(context: Pick<Context, 'page' | 'palette' | 'lib'>, strokes: PdfStroke[], box: { x: number; top: number; width: number; height: number }): number {
  let segments = 0;
  const at = ([x, y]: [number, number]) => ({ x: box.x + Math.min(1, Math.max(0, x)) * box.width, y: box.top - Math.min(1, Math.max(0, y)) * box.height });
  for (const stroke of strokes) {
    if (stroke.length === 1) {
      const point = at(stroke[0]);
      context.page.drawCircle({ x: point.x, y: point.y, size: 0.9, color: context.palette.ink });
      segments += 1;
      continue;
    }
    for (let index = 1; index < stroke.length; index += 1) {
      context.page.drawLine({ start: at(stroke[index - 1]), end: at(stroke[index]), thickness: 1.3, color: context.palette.ink, lineCap: context.lib.LineCapStyle.Round });
      segments += 1;
    }
  }
  return segments;
}

function drawSignature(context: Context, label: string, caption: string, strokes: PdfStroke[]): void {
  ensureSpace(context, SIGNATURE_BOX.height + 36);
  drawLines(context, [label], context.bold, SIZE.row, MARGIN.left, context.palette.muted);
  const top = context.y - 2;
  context.page.drawRectangle({ x: MARGIN.left, y: top - SIGNATURE_BOX.height, width: SIGNATURE_BOX.width, height: SIGNATURE_BOX.height, borderColor: context.palette.line, borderWidth: 0.8 });
  drawSignatureStrokes(context, strokes, { x: MARGIN.left, top, width: SIGNATURE_BOX.width, height: SIGNATURE_BOX.height });
  context.y = top - SIGNATURE_BOX.height - 4;
  drawLines(context, wrapText(caption, CONTENT_WIDTH * WIDTH_SAFETY, measureOf(context.regular, SIZE.row)), context.regular, SIZE.row, MARGIN.left, context.palette.muted);
  context.y -= 4;
}

function drawSection(context: Context, section: PdfSection): void {
  if (section.kind === 'heading') drawHeading(context, section.text);
  else if (section.kind === 'paragraph') drawParagraph(context, section.text, section.muted === true);
  else if (section.kind === 'rows') drawRows(context, section.rows);
  else if (section.kind === 'signature') drawSignature(context, section.label, section.caption, section.strokes);
  else context.y -= section.height ?? 8;
}

/** 모든 쪽 아래에 문구와 "쪽 i / n" 을 찍는다. 전체 쪽 수는 본문을 다 그린 뒤에만 알 수 있다. */
function drawFooters(context: Context, footer: string): void {
  const pages = context.doc.getPages();
  const measure = measureOf(context.regular, SIZE.footer);
  const footerLines = wrapText(sanitizeText(footer), (CONTENT_WIDTH - 70) * WIDTH_SAFETY, measure);
  pages.forEach((page, index) => {
    page.drawLine({ start: { x: MARGIN.left, y: MARGIN.bottom - 12 }, end: { x: PAGE.width - MARGIN.right, y: MARGIN.bottom - 12 }, thickness: 0.4, color: context.palette.line });
    footerLines.slice(0, 2).forEach((line, lineIndex) => {
      page.drawText(line, { x: MARGIN.left, y: MARGIN.bottom - 24 - lineIndex * 10, size: SIZE.footer, font: context.regular, color: context.palette.muted });
    });
    const label = `${index + 1} / ${pages.length}`;
    page.drawText(label, { x: PAGE.width - MARGIN.right - context.regular.widthOfTextAtSize(label, SIZE.footer), y: MARGIN.bottom - 24, size: SIZE.footer, font: context.regular, color: context.palette.muted });
  });
}

/**
 * PDF 바이트를 만든다. pdf-lib/fontkit 은 이 함수가 처음 불릴 때 불러온다(동적 import).
 * 한글 폰트는 부분 임베딩(subset)이라 파일 크기가 크게 늘지 않는다.
 */
export async function buildPdf(spec: PdfSpec, fonts: PdfFonts): Promise<Uint8Array> {
  const [lib, fontkit] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit')]);
  const doc = await lib.PDFDocument.create();
  doc.registerFontkit(fontkit.default);
  const [regular, bold] = await Promise.all([doc.embedFont(fonts.regular, { subset: true }), doc.embedFont(fonts.bold, { subset: true })]);
  const palette: Palette = { text: lib.grayscale(0.12), muted: lib.grayscale(0.4), line: lib.grayscale(0.78), ink: lib.grayscale(0.05) };
  doc.setTitle(sanitizeText(spec.title));
  doc.setProducer('Business Assistant');
  doc.setCreator('Business Assistant');
  if (spec.author) doc.setAuthor(sanitizeText(spec.author));
  doc.setCreationDate(spec.createdAt);
  doc.setModificationDate(spec.createdAt);

  const context: Context = { lib, doc, regular, bold, page: doc.addPage([PAGE.width, PAGE.height]), y: PAGE.height - MARGIN.top, palette };
  drawLines(context, wrapText(spec.title, CONTENT_WIDTH * WIDTH_SAFETY, measureOf(bold, SIZE.title)), bold, SIZE.title, MARGIN.left, palette.text);
  if (spec.subtitle) drawLines(context, wrapText(spec.subtitle, CONTENT_WIDTH * WIDTH_SAFETY, measureOf(regular, SIZE.subtitle)), regular, SIZE.subtitle, MARGIN.left, palette.muted);
  context.y -= 6;
  for (const section of spec.sections) drawSection(context, section);
  drawFooters(context, spec.footer);
  return doc.save();
}
