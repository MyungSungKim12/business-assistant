// 데모 시드 공용 도구: 결정적 UUID, 날짜 계산, 출력 정리.
import { createHash } from 'node:crypto';

/** 모든 데모 데이터에 붙는 표식. 이 표식으로 기존 데이터를 찾아 중복 생성을 막는다. */
export const MARK = '[데모]';

/**
 * 조직과 키로부터 항상 같은 UUID(버전 5 형식)를 만든다. 서버 멱등 키(operation_id)와 템플릿 ID에 쓴다.
 * 조직마다 다른 값을 만들어 다른 매장의 같은 키와 충돌하지 않게 한다.
 */
export function seedUuid(orgId, key) {
  const bytes = createHash('sha1').update(`business-assistant-demo-seed:${orgId}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const KST_MS = 9 * 3_600_000;
/** 한국 시간 기준 오늘(YYYY-MM-DD). */
export function kstToday(now) { return new Date(now.getTime() + KST_MS).toISOString().slice(0, 10); }
export function addDays(isoDate, days) { return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10); }
/** 월=1 … 일=7. */
export function isoWeekday(isoDate) { const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay(); return day === 0 ? 7 : day; }
/** 한국 시간 일시를 오프셋 포함 문자열로 만든다. */
export function kstDateTime(isoDate, time) { return `${isoDate}T${time}:00+09:00`; }
/** 한국 시간 일시를 Z 형식(UTC) 문자열로 만든다(할 일 마감처럼 오프셋을 받지 않는 필드용). */
export function kstToUtcZ(isoDate, time) { return new Date(Date.parse(kstDateTime(isoDate, time))).toISOString(); }

/** 원 단위 금액 값(문자열·숫자)을 정수로 읽는다. 소수가 있으면 오류. */
export function wonOf(value) {
  const number = Number(String(value));
  if (!Number.isFinite(number) || !Number.isInteger(number)) throw new Error('원 단위 정수 금액이 아닙니다.');
  return number;
}
export const wonText = (value) => String(Math.round(Number(value)));

/** 이메일 일부를 가린다. */
export function maskEmail(email) {
  const [name = '', domain = ''] = String(email).split('@');
  return `${name.slice(0, 2)}***@${domain}`;
}

/** 로그·표에 넣기 전에 비밀값을 가린다. */
export function redact(text, secrets) {
  let result = String(text ?? '');
  for (const secret of secrets) if (secret && String(secret).length >= 4) result = result.split(String(secret)).join('***');
  return result;
}

/** 한글(전각) 폭을 2칸으로 계산해 표를 맞춘다. */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(char) ? 2 : 1;
  return width;
}
export function pad(text, width) { return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`; }

export function renderTable(headers, rows) {
  const widths = headers.map((header, index) => Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index] ?? ''))));
  const line = (cells) => cells.map((cell, index) => pad(cell ?? '', widths[index])).join('  ').trimEnd();
  return [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)];
}
