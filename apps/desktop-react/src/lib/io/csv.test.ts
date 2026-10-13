import { describe, expect, it } from 'vitest';
import { decodeCsvBytes, detectDelimiter, encodeCsv, parseCsv, stripBom, writeCsv } from './csv';

describe('parseCsv', () => {
  it('parses simple rows and removes a BOM', () => {
    expect(parseCsv('﻿이름,연락처\n김,010\n')).toEqual([['이름', '연락처'], ['김', '010']]);
  });

  it('keeps line breaks, commas and doubled quotes inside quoted fields', () => {
    const rows = parseCsv('a,b\r\n"첫째 줄\n둘째 줄","x, ""y"""\r\n');
    expect(rows).toEqual([['a', 'b'], ['첫째 줄\n둘째 줄', 'x, "y"']]);
  });

  it('handles CRLF, CR-only and a missing final newline', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('a,b\rc,d\r')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('keeps empty fields and blank lines as rows', () => {
    expect(parseCsv('a,,c\n\nx,y,\n')).toEqual([['a', '', 'c'], [''], ['x', 'y', '']]);
  });

  it('returns no rows for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('﻿')).toEqual([]);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,"b\nc')).toThrow('따옴표');
  });

  it('detects tab and semicolon delimiters', () => {
    expect(detectDelimiter('a\tb\tc\n')).toBe('\t');
    expect(detectDelimiter('a;b;c\n')).toBe(';');
    expect(detectDelimiter('"a,b,c"\td\n')).toBe('\t');
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('writeCsv', () => {
  it('quotes fields that contain commas, quotes or line breaks', () => {
    expect(writeCsv([['a,b', 'c"d', 'e\nf', 'plain']])).toBe('"a,b","c""d","e\nf",plain\r\n');
  });

  it('round-trips through parseCsv', () => {
    const rows = [['이름', '메모'], ['김"고객"', '줄\n바꿈, 쉼표'], ['', '끝']];
    expect(parseCsv(writeCsv(rows))).toEqual(rows);
  });

  it('encodes with a UTF-8 BOM so Excel shows Korean correctly', () => {
    const bytes = encodeCsv([['이름']]);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(stripBom(new TextDecoder().decode(bytes))).toBe('이름\r\n');
  });
});

describe('decodeCsvBytes', () => {
  it('decodes UTF-8 and falls back to CP949 for Korean Excel CSV files', () => {
    expect(decodeCsvBytes(new TextEncoder().encode('이름'))).toBe('이름');
    // "이름" in CP949: C0 CC B8 A7
    expect(decodeCsvBytes(new Uint8Array([0xc0, 0xcc, 0xb8, 0xa7]))).toBe('이름');
  });
});
