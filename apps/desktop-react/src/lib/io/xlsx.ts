import { dateToYmd } from './dates';
import { neutralizeFormula } from './sanitize';

/** exceljs는 크기가 커서 내보내기/가져오기를 실제로 실행할 때만 불러온다. */
async function loadExcel() {
  const mod = await import('exceljs');
  return (mod as unknown as { default?: typeof mod }).default ?? mod;
}

export type CellType = 'text' | 'number' | 'date';
export type SheetCell = string | number | null;

export interface SheetColumn {
  header: string;
  type: CellType;
  /** 열 너비(문자 수). 기본값은 머리글 길이에 맞춘다. */
  width?: number;
  /** 숫자 서식. 기본 '#,##0' */
  numFmt?: string;
}

const MAX_RAW_ROWS = 10_000;

export async function buildXlsx(sheetName: string, columns: readonly SheetColumn[], rows: readonly (readonly SheetCell[])[]): Promise<Uint8Array> {
  const Excel = await loadExcel();
  const workbook = new Excel.Workbook();
  workbook.creator = 'Business Assistant';
  workbook.created = new Date();
  const safeName = sheetName.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet1';
  const sheet = workbook.addWorksheet(safeName, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((column) => ({
    header: column.header,
    width: column.width ?? Math.max(10, Math.min(40, column.header.length * 2 + 2)),
  }));
  const head = sheet.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle' };
  columns.forEach((column, index) => {
    const target = sheet.getColumn(index + 1);
    if (column.type === 'number') target.numFmt = column.numFmt ?? '#,##0';
    else target.numFmt = '@';
  });
  for (const row of rows) {
    sheet.addRow(row.map((value, index) => {
      if (typeof value === 'number') return value;
      if (value === null) return null;
      return columns[index]?.type === 'number' ? value : neutralizeFormula(value);
    }));
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/** 셀 값을 화면 문자열로. 날짜는 YYYY-MM-DD, 수식은 계산 결과, 서식 있는 텍스트는 평문. */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return dateToYmd(value) ?? '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if ('result' in object) return cellToString(object.result);
    if (Array.isArray(object.richText)) return (object.richText as { text?: string }[]).map((part) => part.text ?? '').join('');
    if (typeof object.text === 'string') return object.text;
  }
  return '';
}

/** 첫 번째 시트를 문자열 격자로 읽는다. */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const Excel = await loadExcel();
  const workbook = new Excel.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new Error('엑셀 파일을 읽지 못했습니다. 올바른 .xlsx 파일인지 확인하세요.');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('엑셀 파일에 시트가 없습니다.');
  if (sheet.rowCount > MAX_RAW_ROWS) throw new Error(`시트의 행이 너무 많습니다. (${MAX_RAW_ROWS.toLocaleString('ko-KR')}행 이하)`);
  const width = Math.min(sheet.columnCount, 100);
  const rows: string[][] = [];
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values: string[] = [];
    for (let column = 1; column <= width; column += 1) values.push(cellToString(row.getCell(column).value));
    rows.push(values);
  }
  return rows;
}
