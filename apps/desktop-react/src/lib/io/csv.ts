/** RFC 4180 CSV 읽기·쓰기. 외부 라이브러리 없이 따옴표 안의 쉼표·줄바꿈·이중 따옴표를 처리한다. */

export const UTF8_BOM = '\uFEFF';

export function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

/** 첫 줄(따옴표 밖)에서 가장 많이 쓰인 구분자를 고른다. 동률·없음은 쉼표. */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, '\t': 0, ';': 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char] += 1;
  }
  if (counts['\t'] > counts[','] && counts['\t'] >= counts[';']) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

export interface ParseCsvOptions {
  delimiter?: string;
}

/**
 * CSV 텍스트를 행 배열로 바꾼다. BOM을 제거하고, 따옴표 안의 줄바꿈을 값으로 보존한다.
 * 완전히 빈 행(모든 칸이 공백)은 결과에서 제외하지 않는다. 필터링은 호출자가 한다.
 */
export function parseCsv(input: string, options: ParseCsvOptions = {}): string[][] {
  const text = stripBom(input);
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      endRow();
    } else if (char === '\n') {
      endRow();
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (quoted) throw new Error('CSV 파일의 따옴표가 닫히지 않았습니다.');
  if (field !== '' || row.length > 0 || fieldStarted) endRow();
  return rows;
}

function quoteField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 행 배열을 CSV 텍스트로 만든다(줄 끝 CRLF). BOM은 붙이지 않는다. */
export function writeCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(quoteField).join(',')).join('\r\n') + '\r\n';
}

/** Excel이 한글을 UTF-8로 인식하도록 BOM을 붙인 바이트. */
export function encodeCsv(rows: readonly (readonly string[])[]): Uint8Array {
  return new TextEncoder().encode(UTF8_BOM + writeCsv(rows));
}

/** 바이트를 문자열로 푼다. UTF-8이 아니면(한국어 Excel의 CSV 기본값) CP949(euc-kr)로 다시 시도한다. */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}
