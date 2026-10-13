import type { FileAsset } from './schemas';

export type PreviewKind = 'image' | 'pdf';

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** 미리보기 형식과 Blob 에 붙일 MIME. 형식이 octet-stream 이면 확장자로 판단하고, 지원하지 않으면 null. */
export function previewTypeOf(file: Pick<FileAsset, 'content_type' | 'original_name'>): { kind: PreviewKind; mime: string } | null {
  const declared = file.content_type.split(';')[0].trim().toLowerCase();
  if (declared === 'application/pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (declared === 'image/png' || declared === 'image/jpeg' || declared === 'image/webp') return { kind: 'image', mime: declared };
  if (declared === 'image/jpg') return { kind: 'image', mime: 'image/jpeg' };
  if (declared !== '' && declared !== 'application/octet-stream') return null;
  const extension = extensionOf(file.original_name);
  if (extension === 'pdf') return { kind: 'pdf', mime: 'application/pdf' };
  return IMAGE_TYPES[extension] ? { kind: 'image', mime: IMAGE_TYPES[extension] } : null;
}

export const isPreviewable = (file: FileAsset): boolean => !file.is_archived && previewTypeOf(file) !== null;
