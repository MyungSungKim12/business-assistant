import { saveDataFile } from '../io/fileAccess';

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** PDF 파일 이름: 경로·금지 문자를 없애고 .pdf 로 끝나게 한다(Rust 저장 명령과 같은 규칙). */
export function pdfFileName(base: string): string {
  const cleaned = base.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.pdf$/i, '').slice(0, 120).trim();
  return `${cleaned || '문서'}.pdf`;
}

function downloadInBrowser(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** PDF 저장. 저장하면 true, 저장 대화상자를 취소하면 false. 데스크톱은 Rust save_data_file(.pdf 허용)을 쓴다. */
export async function savePdf(name: string, bytes: Uint8Array): Promise<boolean> {
  const fileName = pdfFileName(name);
  if (isTauri()) return saveDataFile(fileName, bytes);
  downloadInBrowser(fileName, bytes);
  return true;
}
