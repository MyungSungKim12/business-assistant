import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../api/errors';
import { describePhotoError } from './photoErrors';

describe('describePhotoError', () => {
  it('explains the missing storage host setting', () => {
    expect(describePhotoError(new Error('허용되지 않은 Storage 주소입니다. (x.supabase.co)'))).toContain('BUSINESS_ASSISTANT_STORAGE_HOST');
  });
  it('maps connection and permission failures to actionable sentences', () => {
    expect(describePhotoError(new ApiError(0, 'NATIVE_TRANSPORT', '서버에 연결하지 못했습니다: refused', true))).toContain('API 서버');
    expect(describePhotoError(new ApiError(403, 'HTTP_403', 'Access denied', false))).toContain('권한');
    expect(describePhotoError(new ApiError(404, 'HTTP_404', 'Not found', false))).toContain('찾을 수');
  });
  it('keeps validation messages and falls back to the raw cause', () => {
    expect(describePhotoError(new Error('사진은 10MB 이하여야 합니다.'))).toBe('사진은 10MB 이하여야 합니다.');
    expect(describePhotoError(new Error('boom'))).toBe('원인: boom');
    expect(describePhotoError(undefined)).toContain('알 수 없는');
  });
});
