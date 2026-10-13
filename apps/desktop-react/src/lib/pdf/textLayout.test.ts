import { describe, expect, it } from 'vitest';
import { cachedMeasure, sanitizeText, wrapText } from './textLayout';

// 글자 하나가 10 단위 너비인 가짜 측정기.
const measure = (text: string) => [...text].length * 10;

describe('sanitizeText', () => {
  it('줄바꿈을 통일하고 탭을 공백으로, 제어 문자를 지운다', () => {
    expect(sanitizeText('a\r\nb\rc\td\u0000e')).toBe('a\nb\nc    de');
  });
});

describe('wrapText', () => {
  it('공백 단위로 줄을 나눈다', () => {
    expect(wrapText('aaa bbb ccc', 70, measure)).toEqual(['aaa bbb', 'ccc']);
  });

  it('줄바꿈과 빈 줄을 지킨다', () => {
    expect(wrapText('첫째\n\n셋째', 100, measure)).toEqual(['첫째', '', '셋째']);
  });

  it('공백 없는 긴 단어(한글 장문·해시)는 글자 단위로 자른다', () => {
    expect(wrapText('가나다라마바사아자차', 40, measure)).toEqual(['가나다라', '마바사아', '자차']);
    expect(wrapText('x'.repeat(64), 320, measure)).toEqual(['x'.repeat(32), 'x'.repeat(32)]);
  });

  it('긴 단어 뒤의 단어는 남은 줄에 이어 붙는다', () => {
    expect(wrapText('가나다라마 바', 40, measure)).toEqual(['가나다라', '마 바']);
  });

  it('어떤 줄도 최대 너비를 넘지 않는다', () => {
    const text = '시술 전 주의사항을 충분히 설명했고 고객은 내용을 이해하였으며 동의합니다. '.repeat(20);
    for (const line of wrapText(text, 200, measure)) expect(measure(line)).toBeLessThanOrEqual(200);
  });

  it('글자 너비 측정기는 같은 글자를 한 번만 잰다', () => {
    let calls = 0;
    const counted = cachedMeasure((text) => {
      calls += 1;
      return measure(text);
    });
    expect(counted('aaab')).toBe(40);
    expect(calls).toBe(2);
  });
});
