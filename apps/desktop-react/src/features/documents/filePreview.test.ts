import { describe, expect, it } from 'vitest';
import { isPreviewable, previewTypeOf } from './filePreview';
import { file } from './testkit';

const of = (content_type: string, original_name: string) => previewTypeOf({ ...file, content_type, original_name });

describe('previewTypeOf', () => {
  it.each([
    ['image/png', 'a.png', 'image', 'image/png'],
    ['image/jpeg', 'a.jpg', 'image', 'image/jpeg'],
    ['image/webp', 'a.webp', 'image', 'image/webp'],
    ['application/pdf', 'a.pdf', 'pdf', 'application/pdf'],
    ['IMAGE/PNG; charset=binary', 'a.png', 'image', 'image/png'],
    ['image/jpg', 'a.jpg', 'image', 'image/jpeg'],
  ])('%s 는 %s 미리보기', (contentType, name, kind, mime) => {
    expect(of(contentType, name)).toEqual({ kind, mime });
  });

  it('형식이 비었거나 octet-stream 이면 확장자로 판단한다', () => {
    expect(of('application/octet-stream', '스캔.PDF')).toEqual({ kind: 'pdf', mime: 'application/pdf' });
    expect(of('', 'photo.JPEG')).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(of('application/octet-stream', 'data.bin')).toBeNull();
  });

  it.each([['application/zip', 'a.zip'], ['text/plain', 'a.txt'], ['image/gif', 'a.gif'], ['image/svg+xml', 'a.svg'], ['application/pdf-fake', 'a.pdf']])('%s 는 미리보기를 지원하지 않는다', (contentType, name) => {
    expect(of(contentType, name)).toBeNull();
  });
});

describe('isPreviewable', () => {
  it('보관된 파일은 미리보기하지 않는다', () => {
    expect(isPreviewable(file)).toBe(true);
    expect(isPreviewable({ ...file, is_archived: true })).toBe(false);
    expect(isPreviewable({ ...file, content_type: 'application/zip', original_name: 'a.zip' })).toBe(false);
  });
});
