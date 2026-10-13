/**
 * 파일 선택·저장. Tauri에서는 Rust 명령(pick_data_file/save_data_file)으로, 브라우저 미리보기에서는
 * <input type=file>/Blob 다운로드로 처리한다. 파일 내용은 로그에 남기지 않는다.
 */
import { invoke } from '@tauri-apps/api/core';

export const MAX_DATA_FILE_BYTES = 5 * 1024 * 1024;

export interface PickedDataFile {
  name: string;
  bytes: Uint8Array;
}

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** 크기·확장자 사전 검사(브라우저 경로용). 문제가 있으면 안내 문구를 돌려준다. */
export function checkDataFile(name: string, size: number): string | null {
  const extension = extensionOf(name);
  if (extension !== 'csv' && extension !== 'xlsx') return '엑셀(.xlsx) 또는 CSV 파일만 선택할 수 있습니다.';
  if (size === 0) return '빈 파일입니다.';
  if (size > MAX_DATA_FILE_BYTES) return '파일은 5MB 이하여야 합니다.';
  return null;
}

function errorText(error: unknown): string {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : '파일을 처리하지 못했습니다.';
}

function pickInBrowser(): Promise<PickedDataFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.csv';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const problem = checkDataFile(file.name, file.size);
      if (problem) {
        reject(new Error(problem));
        return;
      }
      file.arrayBuffer().then((buffer) => resolve({ name: file.name, bytes: new Uint8Array(buffer) }), reject);
    };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** 가져오기 파일 선택. 취소하면 null, 형식·크기 문제는 Error(안내 문구). */
export async function pickDataFile(): Promise<PickedDataFile | null> {
  if (!isTauri()) return pickInBrowser();
  try {
    const picked = await invoke<{ name: string; size: number; bytes: number[] } | null>('pick_data_file');
    return picked ? { name: picked.name, bytes: Uint8Array.from(picked.bytes) } : null;
  } catch (error) {
    throw new Error(errorText(error));
  }
}

function downloadInBrowser(name: string, bytes: Uint8Array): void {
  const type = extensionOf(name) === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv;charset=utf-8';
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 파일 저장. 저장하면 true, 사용자가 저장 대화상자를 취소하면 false. */
export async function saveDataFile(suggestedName: string, bytes: Uint8Array): Promise<boolean> {
  if (!isTauri()) {
    downloadInBrowser(suggestedName, bytes);
    return true;
  }
  try {
    const saved = await invoke<string | null>('save_data_file', { suggestedName, bytes: Array.from(bytes) });
    return saved !== null;
  } catch (error) {
    throw new Error(errorText(error));
  }
}
