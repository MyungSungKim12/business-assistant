import { decodeCsvBytes, parseCsv } from './csv';
import { extensionOf } from './fileAccess';
import { readXlsx } from './xlsx';

export const MAX_IMPORT_ROWS = 2_000;

export interface ParsedTable {
  headers: string[];
  /** 빈 행을 제외한 데이터 행. sourceRow는 파일에서의 행 번호(첫 줄이 1) */
  rows: { sourceRow: number; cells: string[] }[];
  /** 제외한 빈 행 수 */
  blankRows: number;
}

const isBlank = (cells: readonly string[]) => cells.every((cell) => cell.trim() === '');

/** 격자에서 머리글(첫 비어 있지 않은 행)과 데이터 행을 가른다. 행 수 제한을 넘으면 Error. */
export function tableFromGrid(grid: readonly (readonly string[])[], maxRows = MAX_IMPORT_ROWS): ParsedTable {
  const headerIndex = grid.findIndex((row) => !isBlank(row));
  if (headerIndex < 0) throw new Error('파일에 내용이 없습니다.');
  const headers = grid[headerIndex].map((cell) => cell.trim());
  const rows: ParsedTable['rows'] = [];
  let blankRows = 0;
  for (let index = headerIndex + 1; index < grid.length; index += 1) {
    if (isBlank(grid[index])) {
      blankRows += 1;
      continue;
    }
    rows.push({ sourceRow: index + 1, cells: [...grid[index]] });
  }
  if (rows.length === 0) throw new Error('머리글 아래에 데이터 행이 없습니다.');
  if (rows.length > maxRows) {
    throw new Error(`한 번에 ${maxRows.toLocaleString('ko-KR')}행까지 가져올 수 있습니다. (파일 ${rows.length.toLocaleString('ko-KR')}행) 파일을 나누어 가져오세요.`);
  }
  return { headers, rows, blankRows };
}

/** 파일 바이트를 표로 읽는다. 확장자와 내용이 맞지 않으면 Error. */
export async function readTableFile(name: string, bytes: Uint8Array): Promise<ParsedTable> {
  const extension = extensionOf(name);
  const isZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (extension === 'xlsx') {
    if (!isZip) throw new Error('올바른 엑셀(.xlsx) 파일이 아닙니다.');
    return tableFromGrid(await readXlsx(bytes));
  }
  if (extension === 'csv') {
    if (isZip || bytes.includes(0)) throw new Error('CSV 파일이 아닙니다. 파일 형식을 확인하세요.');
    return tableFromGrid(parseCsv(decodeCsvBytes(bytes)));
  }
  throw new Error('엑셀(.xlsx) 또는 CSV 파일만 가져올 수 있습니다.');
}
