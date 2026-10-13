import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { buildExport, safeFileName, toNumber, type ExportColumn } from './exportTable';
import { readXlsx } from './xlsx';

interface Row { name: string; amount: string; date: string; memo: string | null }
const columns: ExportColumn<Row>[] = [
  { header: '이름', value: (row) => row.name },
  { header: '금액', type: 'number', value: (row) => row.amount },
  { header: '날짜', type: 'date', value: (row) => row.date },
  { header: '메모', value: (row) => row.memo },
];
const rows: Row[] = [
  { name: '=HYPERLINK("x")', amount: '12000.5', date: '2024-03-05', memo: '줄\n바꿈, 쉼표' },
  { name: '김고객', amount: '-300', date: '2024-03-06', memo: null },
];
const now = new Date(2026, 9, 13);

describe('toNumber / safeFileName', () => {
  it('parses decimal strings and rejects text', () => {
    expect(toNumber('12000.50')).toBe(12000.5);
    expect(toNumber('-3')).toBe(-3);
    expect(toNumber('1,000')).toBeNull();
    expect(toNumber('abc')).toBeNull();
    expect(toNumber(7)).toBe(7);
  });

  it('builds a safe dated file name', () => {
    expect(safeFileName('수입/지출: 내역', 'xlsx', now)).toBe('수입지출_내역_20261013.xlsx');
    expect(safeFileName('///', 'csv', now)).toBe('내보내기_20261013.csv');
  });
});

describe('buildExport', () => {
  it('writes CSV with BOM, injection defense and numeric amounts left intact', async () => {
    const { fileName, bytes } = await buildExport({ title: '테스트', columns, rows, format: 'csv', now });
    expect(fileName).toBe('테스트_20261013.csv');
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const parsed = parseCsv(new TextDecoder().decode(bytes));
    expect(parsed[0]).toEqual(['이름', '금액', '날짜', '메모']);
    expect(parsed[1]).toEqual(["'=HYPERLINK(\"x\")", '12000.5', '2024-03-05', '줄\n바꿈, 쉼표']);
    expect(parsed[2]).toEqual(['김고객', '-300', '2024-03-06', '']);
  });

  it('writes XLSX with real numeric cells and text dates', async () => {
    const { fileName, bytes } = await buildExport({ title: '테스트', columns, rows, format: 'xlsx', now });
    expect(fileName.endsWith('.xlsx')).toBe(true);
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
    const grid = await readXlsx(bytes);
    expect(grid[0]).toEqual(['이름', '금액', '날짜', '메모']);
    expect(grid[1]).toEqual(["'=HYPERLINK(\"x\")", '12000.5', '2024-03-05', '줄\n바꿈, 쉼표']);
    expect(grid[2][1]).toBe('-300');
    const Excel = (await import('exceljs')).default;
    const workbook = new Excel.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(typeof workbook.worksheets[0].getRow(2).getCell(2).value).toBe('number');
  }, 20_000);

  it('exports only headers for no rows', async () => {
    const { bytes } = await buildExport({ title: '빈 목록', columns, rows: [], format: 'csv', now });
    expect(parseCsv(new TextDecoder().decode(bytes))).toEqual([['이름', '금액', '날짜', '메모']]);
  });
});
