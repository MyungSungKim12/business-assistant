import { encodeCsv } from './csv';
import { neutralizeFormula } from './sanitize';
import { saveDataFile } from './fileAccess';
import { buildXlsx, type CellType, type SheetCell } from './xlsx';

export type ExportFormat = 'xlsx' | 'csv';
export type ExportValue = string | number | null | undefined;

export interface ExportColumn<T> {
  header: string;
  /** 'number'는 엑셀 숫자 셀(합계 가능)로, 'date'는 YYYY-MM-DD 텍스트로 저장한다. 기본 'text'. */
  type?: CellType;
  width?: number;
  value: (row: T) => ExportValue;
}

export interface ExportTableOptions<T> {
  title: string;
  columns: readonly ExportColumn<T>[];
  rows: readonly T[];
  format: ExportFormat;
  /** 파일 이름 날짜(테스트용으로 고정 가능) */
  now?: Date;
}

/** "12000.50" 같은 금액 문자열을 숫자로. 해석할 수 없으면 null(빈 셀). */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value.trim())) return null;
  return Number(value.trim());
}

export function safeFileName(title: string, extension: string, now = new Date()): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, '_').slice(0, 60) || '내보내기';
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `${cleaned}_${stamp}.${extension}`;
}

function cellFor<T>(column: ExportColumn<T>, row: T): SheetCell {
  const raw = column.value(row);
  if (raw === null || raw === undefined || raw === '') return null;
  if (column.type === 'number') return toNumber(raw);
  return String(raw);
}

/** 파일로 만들 바이트와 파일 이름까지 준비한다(저장 전 단계. 테스트 가능). */
export async function buildExport<T>(options: ExportTableOptions<T>): Promise<{ fileName: string; bytes: Uint8Array }> {
  const { title, columns, rows, format } = options;
  const cells = rows.map((row) => columns.map((column) => cellFor(column, row)));
  const fileName = safeFileName(title, format, options.now);
  if (format === 'xlsx') {
    const sheetColumns = columns.map((column) => ({ header: column.header, type: column.type ?? 'text', width: column.width }));
    return { fileName, bytes: await buildXlsx(title, sheetColumns, cells) };
  }
  const textRows = [
    columns.map((column) => column.header),
    ...cells.map((row) => row.map((value, index) => {
      if (value === null) return '';
      if (typeof value === 'number') return String(value);
      return columns[index].type === 'number' ? value : neutralizeFormula(value);
    })),
  ];
  return { fileName, bytes: encodeCsv(textRows) };
}

/** 공통 내보내기. 저장하면 true, 저장 대화상자를 취소하면 false. */
export async function exportTable<T>(options: ExportTableOptions<T>): Promise<boolean> {
  const { fileName, bytes } = await buildExport(options);
  return saveDataFile(fileName, bytes);
}
