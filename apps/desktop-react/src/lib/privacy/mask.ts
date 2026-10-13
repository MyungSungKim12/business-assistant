/** 개인정보 가림 표시 유틸(SEC-07). 화면 표시용이며 저장·전송 값은 바꾸지 않는다. */

const MASK = '*';

/**
 * 전화번호 가운데 자리를 *로 가린다. 숫자가 아닌 문자(하이픈·공백·괄호·+)는 그대로 둔다.
 * 010-1234-5678 -> 010-****-5678, 02-123-4567 -> 02-***-4567, 01012345678 -> 010****5678.
 * 비어 있거나 숫자가 없으면 원문을 그대로 돌려준다.
 */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  const count = digits.length;
  if (count === 0) return value;
  const keepEnd = count <= 4 ? 0 : count <= 6 ? 2 : 4;
  const keepStart = count <= 6 ? 0 : count >= 10 ? (digits.startsWith('02') ? 2 : 3) : 2;
  let seen = 0;
  return value.replace(/\d/g, (digit) => {
    const index = seen;
    seen += 1;
    return index < keepStart || index >= count - keepEnd ? digit : MASK;
  });
}

/** 이메일 앞부분을 첫 글자만 남기고 가린다. abcdef@example.com -> a*****@example.com (도메인은 유지). */
export function maskEmail(value: string | null | undefined): string {
  if (!value) return '';
  const at = value.lastIndexOf('@');
  if (at < 1) return value.length <= 1 ? MASK : `${value[0]}${MASK.repeat(Math.min(value.length - 1, 5))}`;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  return `${local[0]}${MASK.repeat(Math.min(Math.max(local.length - 1, 1), 5))}${domain}`;
}
