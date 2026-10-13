import boldUrl from '../../assets/fonts/SUIT-Bold.ttf?url';
import regularUrl from '../../assets/fonts/SUIT-Regular.ttf?url';
import type { PdfFonts } from './types';

let cached: Promise<PdfFonts> | null = null;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`글꼴을 불러오지 못했습니다. (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** PDF 에 임베드할 SUIT 글꼴(Regular/Bold). 앱에 포함된 파일을 한 번만 읽어 재사용한다. 실패하면 다음 호출에서 다시 시도한다. */
export function loadPdfFonts(): Promise<PdfFonts> {
  if (!cached) {
    cached = Promise.all([fetchBytes(regularUrl), fetchBytes(boldUrl)])
      .then(([regular, bold]) => ({ regular, bold }))
      .catch((error: unknown) => {
        cached = null;
        throw error;
      });
  }
  return cached;
}
