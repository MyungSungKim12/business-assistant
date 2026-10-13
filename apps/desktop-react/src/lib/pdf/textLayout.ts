import type { TextMeasure } from './types';

/** 글자 모양이 없는 제어 문자와 보이지 않는 서식 문자(제로폭 공백, 줄/문단 구분자, BOM). */
function isInvisible(code: number): boolean {
  return code <= 0x09 || (code >= 0x0b && code <= 0x1f) || code === 0x7f || (code >= 0x200b && code <= 0x200f) || code === 0x2028 || code === 0x2029 || code === 0xfeff;
}

/** 보이지 않는 문자를 지우고 줄바꿈을 통일한다. 탭은 공백 4칸. */
export function sanitizeText(text: string): string {
  const unified = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  let cleaned = '';
  for (const char of unified) {
    if (!isInvisible(char.codePointAt(0) ?? 0)) cleaned += char;
  }
  return cleaned;
}

/** 글자 하나의 너비를 캐시해 긴 본문도 빠르게 잰다. */
export function cachedMeasure(measure: TextMeasure): TextMeasure {
  const cache = new Map<string, number>();
  return (text) => {
    let total = 0;
    for (const char of text) {
      let width = cache.get(char);
      if (width === undefined) {
        width = measure(char);
        cache.set(char, width);
      }
      total += width;
    }
    return total;
  };
}

function hardWrap(word: string, maxWidth: number, measure: TextMeasure): string[] {
  const lines: string[] = [];
  let line = '';
  for (const char of word) {
    if (line && measure(line + char) > maxWidth) {
      lines.push(line);
      line = char;
    } else {
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * 문단을 maxWidth 안에서 줄로 나눈다. 줄바꿈(\n)은 그대로 지키고, 공백 단위로 나누되
 * 한 단어가 한 줄보다 길면(한글 장문·해시 등) 글자 단위로 자른다. 빈 줄은 빈 문자열로 남긴다.
 */
export function wrapText(text: string, maxWidth: number, measure: TextMeasure): string[] {
  const lines: string[] = [];
  for (const paragraph of sanitizeText(text).split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (measure(word) <= maxWidth) {
        line = word;
        continue;
      }
      const pieces = hardWrap(word, maxWidth, measure);
      lines.push(...pieces.slice(0, -1));
      line = pieces[pieces.length - 1] ?? '';
    }
    lines.push(line);
  }
  return lines;
}
