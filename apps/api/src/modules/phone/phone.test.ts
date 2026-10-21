import { describe, expect, it } from 'vitest';
import { normalizePhoneNumber } from './phone.js';

describe('normalizePhoneNumber', () => {
  it.each([
    ['010-1234-5678', '+821012345678'],
    ['+82 10 1234 5678', '+821012345678'],
    ['0212345678', '+82212345678'],
    ['+1 (415) 555-0123', '+14155550123'],
  ])('normalizes %s', (input, expected) => expect(normalizePhoneNumber(input)).toBe(expected));

  it.each(['', '발신번호 표시제한', '010-123', '1234567', '00000000000', '010-0000-0000'])('rejects unusable number %s', input => expect(normalizePhoneNumber(input)).toBeNull());
});
