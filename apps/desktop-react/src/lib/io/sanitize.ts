/** 스프레드시트에서 수식으로 실행될 수 있는 시작 문자. */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEUTRALIZED = /^'[=+\-@\t\r]/;

/**
 * CSV/XLSX 수식 주입(CSV injection) 방어: 위험한 문자로 시작하는 텍스트 앞에 작은따옴표를 붙인다.
 * 숫자 열(number 타입)에는 적용하지 않는다(음수 금액이 깨지지 않도록 호출자가 구분한다).
 */
export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** 내보내기에서 붙인 방어용 작은따옴표를 가져오기 때 되돌린다(내보낸 파일을 다시 가져오는 경우). */
export function restoreNeutralized(value: string): string {
  return NEUTRALIZED.test(value) ? value.slice(1) : value;
}
