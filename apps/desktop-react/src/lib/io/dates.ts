/** 날짜 변환 도우미. 모두 달력상 유효한 날짜만 'YYYY-MM-DD'로 돌려주고, 아니면 null. */

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

export function isValidYmd(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= last;
}

export function formatYmd(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** 엑셀 날짜 일련번호(1900 체계, 1900-02-29 오류 보정 포함)를 YYYY-MM-DD로. 시간 소수점은 버린다. */
export function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial >= 2_958_466) return null;
  const whole = Math.floor(serial);
  // 1900-03-01(60 다음)부터는 가상의 1900-02-29 때문에 하루를 뺀다. 60 자체는 존재하지 않는 날짜.
  if (whole === 60) return null;
  const days = whole > 60 ? whole - 1 : whole;
  const date = new Date(Date.UTC(1899, 11, 31) + days * 86_400_000);
  return formatYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Date 객체(엑셀 셀 값)를 UTC 기준 날짜로. ExcelJS는 날짜를 UTC 자정 Date로 준다. */
export function dateToYmd(date: Date): string | null {
  if (Number.isNaN(date.getTime())) return null;
  return formatYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * 사용자가 입력한 날짜 문자열을 YYYY-MM-DD로 맞춘다.
 * 허용: 2024-03-05, 2024.3.5, 2024/03/05, 20240305, 엑셀 일련번호(5~6자리 정수), 시간이 붙은 ISO 문자열.
 * 빈 문자열은 null이 아니라 ''로 구분하지 않고 호출자가 먼저 처리한다.
 */
export function normalizeDate(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const iso = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (iso) return isValidYmd(+iso[1], +iso[2], +iso[3]) ? formatYmd(+iso[1], +iso[2], +iso[3]) : null;
  const korean = /^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/.exec(text);
  if (korean) return isValidYmd(+korean[1], +korean[2], +korean[3]) ? formatYmd(+korean[1], +korean[2], +korean[3]) : null;
  if (/^\d{8}$/.test(text)) {
    const year = +text.slice(0, 4), month = +text.slice(4, 6), day = +text.slice(6, 8);
    return isValidYmd(year, month, day) ? formatYmd(year, month, day) : null;
  }
  if (/^\d{5,6}(\.\d+)?$/.test(text)) return excelSerialToDate(Number(text));
  return null;
}
