/** E.164 phone number for matching. Unknown/private and malformed numbers never match a customer. */
export function normalizePhoneNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || /[a-z가-힣]/i.test(trimmed)) return null;
  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('0082')) digits = `82${digits.slice(4)}`;
  else if (digits.startsWith('00') && !hasPlus) digits = digits.slice(2);
  if (digits.startsWith('82')) digits = `0${digits.slice(2)}`;
  if (digits.startsWith('0')) {
    if (digits.length < 8 || digits.length > 11 || /^0+$/.test(digits)) return null;
    if (/^0(?:10|11|16|17|18|19)0{4,}/.test(digits)) return null;
    return `+82${digits.slice(1)}`;
  }
  if (!hasPlus || digits.length < 8 || digits.length > 15 || /^0+$/.test(digits)) return null;
  return `+${digits}`;
}
