import type { BinarySource } from '../../platform/types';

export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_NAME_LENGTH = 255;

/** 서버(upload-url)와 같은 한도: 이름 1~255자, 크기 0~50MB. 형식이 비면 octet-stream으로 보낸다. */
export function validateFile(file: Pick<BinarySource, 'name' | 'size' | 'contentType'>): void {
  const name = file.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH) throw new Error('파일 이름은 1~255자여야 합니다.');
  if (!Number.isFinite(file.size) || file.size < 0) throw new Error('파일 크기를 확인할 수 없습니다.');
  if (file.size > MAX_FILE_SIZE) throw new Error('파일은 50MB 이하만 올릴 수 있습니다.');
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
