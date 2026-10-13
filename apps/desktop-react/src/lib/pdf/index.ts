import { loadPdfFonts } from './fonts';
import type { PdfSpec } from './types';

export type { PdfFonts, PdfSection, PdfSpec, PdfStroke } from './types';
export { pdfFileName, savePdf } from './savePdf';
export { sha256Hex } from './sha256';
export { wrapText } from './textLayout';

/** 문서 설명으로 PDF 바이트를 만든다. pdf-lib 와 글꼴은 이 함수를 처음 부를 때만 불러온다. */
export async function renderPdf(spec: PdfSpec): Promise<Uint8Array> {
  const [{ buildPdf }, fonts] = await Promise.all([import('./buildPdf'), loadPdfFonts()]);
  return buildPdf(spec, fonts);
}
