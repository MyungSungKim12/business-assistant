import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_ROWS, readTableFile, tableFromGrid } from './readTable';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('tableFromGrid', () => {
  it('skips leading blank rows and ignores blank data rows while keeping source row numbers', () => {
    const table = tableFromGrid([['', ''], [' 이름 ', '연락처'], ['김', '010'], ['', ' '], ['이', '011']]);
    expect(table.headers).toEqual(['이름', '연락처']);
    expect(table.rows.map((row) => row.sourceRow)).toEqual([3, 5]);
    expect(table.blankRows).toBe(1);
  });

  it('rejects empty files and header-only files', () => {
    expect(() => tableFromGrid([])).toThrow('내용이 없습니다');
    expect(() => tableFromGrid([['이름']])).toThrow('데이터 행이 없습니다');
  });

  it('accepts exactly the row limit and rejects one more', () => {
    const rows = (count: number) => [['이름'], ...Array.from({ length: count }, (_, index) => [`고객${index}`])];
    expect(tableFromGrid(rows(MAX_IMPORT_ROWS)).rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(() => tableFromGrid(rows(MAX_IMPORT_ROWS + 1))).toThrow('2,000행');
  });
});

describe('readTableFile', () => {
  it('reads CSV with BOM and quoted line breaks', async () => {
    const table = await readTableFile('고객.csv', bytes('﻿이름,메모\n김,"a\nb"\n'));
    expect(table.rows[0].cells).toEqual(['김', 'a\nb']);
  });

  it('rejects wrong or disguised files', async () => {
    await expect(readTableFile('a.txt', bytes('x'))).rejects.toThrow('엑셀');
    await expect(readTableFile('a.xlsx', bytes('이름,연락처'))).rejects.toThrow('올바른 엑셀');
    await expect(readTableFile('a.csv', new Uint8Array([0x50, 0x4b, 3, 4]))).rejects.toThrow('CSV 파일이 아닙니다');
    await expect(readTableFile('a.csv', new Uint8Array([97, 0, 98]))).rejects.toThrow('CSV 파일이 아닙니다');
    await expect(readTableFile('a.xlsx', new Uint8Array([0x50, 0x4b, 1, 2, 3]))).rejects.toThrow('엑셀 파일을 읽지 못했습니다');
  }, 20_000);
});
