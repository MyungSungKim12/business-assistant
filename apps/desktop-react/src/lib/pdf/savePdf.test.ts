import { afterEach, describe, expect, it, vi } from 'vitest';
import { pdfFileName, savePdf } from './savePdf';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

afterEach(() => {
  vi.restoreAllMocks();
  invoke.mockReset();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('pdfFileName', () => {
  it('금지 문자를 없애고 .pdf 로 끝낸다', () => {
    expect(pdfFileName('동의서/김고객: 2026*10?')).toBe('동의서 김고객 2026 10.pdf');
    expect(pdfFileName('a.PDF')).toBe('a.pdf');
    expect(pdfFileName('  ')).toBe('문서.pdf');
    expect(pdfFileName('x'.repeat(300)).length).toBe(124);
  });
});

describe('savePdf', () => {
  it('브라우저에서는 application/pdf Blob 으로 내려받는다', async () => {
    const createObjectURL = vi.fn(() => 'blob:pdf');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    expect(await savePdf('동의서', new Uint8Array([37, 80, 68, 70]))).toBe(true);
    expect(click).toHaveBeenCalled();
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('application/pdf');
  });

  it('데스크톱에서는 save_data_file 로 .pdf 이름과 바이트를 보낸다', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue('C:/동의서.pdf');
    expect(await savePdf('동의서', new Uint8Array([37, 80, 68, 70]))).toBe(true);
    expect(invoke).toHaveBeenCalledWith('save_data_file', { suggestedName: '동의서.pdf', bytes: [37, 80, 68, 70] });
  });

  it('저장 대화상자를 취소하면 false', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(null);
    expect(await savePdf('a', new Uint8Array([1]))).toBe(false);
  });
});
