import { describe, expect, it } from 'vitest';
import { maskEmail, maskPhone } from './mask';

describe('maskPhone', () => {
  it.each([
    ['010-1234-5678', '010-****-5678'],
    ['01012345678', '010****5678'],
    ['010 1234 5678', '010 **** 5678'],
    ['02-123-4567', '02-***-4567'],
    ['02-1234-5678', '02-****-5678'],
    ['031-123-4567', '031-***-4567'],
    ['(010) 9876-5432', '(010) ****-5432'],
    ['1234567', '12*4567'],
    ['12345', '***45'],
    ['123', '***'],
  ])('%s -> %s', (input, expected) => {
    expect(maskPhone(input)).toBe(expected);
  });

  it('비어 있거나 숫자가 없으면 그대로 둔다', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
    expect(maskPhone('없음')).toBe('없음');
  });

  it('뒤 네 자리 외의 가운데 숫자는 원문에 남지 않는다', () => {
    const masked = maskPhone('010-1234-5678');
    expect(masked).not.toContain('1234');
    expect(masked.endsWith('5678')).toBe(true);
  });
});

describe('maskEmail', () => {
  it.each([
    ['abcdef@example.com', 'a*****@example.com'],
    ['ab@example.com', 'a*@example.com'],
    ['a@example.com', 'a*@example.com'],
    ['very.long.address@shop.kr', 'v*****@shop.kr'],
  ])('%s -> %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });

  it('형식이 이상한 값도 앞 한 글자만 남긴다', () => {
    expect(maskEmail('')).toBe('');
    expect(maskEmail(null)).toBe('');
    expect(maskEmail('x')).toBe('*');
    expect(maskEmail('nodomain')).toBe('n*****');
  });
});
