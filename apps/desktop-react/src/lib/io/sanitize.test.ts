import { describe, expect, it } from 'vitest';
import { neutralizeFormula, restoreNeutralized } from './sanitize';

describe('neutralizeFormula', () => {
  it.each(['=1+1', '+82 10', '-1', '@SUM(A1)', '\t=x', '\r=x'])('prefixes %j', (value) => {
    expect(neutralizeFormula(value)).toBe(`'${value}`);
  });

  it('leaves safe text alone', () => {
    expect(neutralizeFormula('홍길동')).toBe('홍길동');
    expect(neutralizeFormula('a=b')).toBe('a=b');
    expect(neutralizeFormula('')).toBe('');
  });

  it('is reversed on import only for neutralized values', () => {
    expect(restoreNeutralized("'=1+1")).toBe('=1+1');
    expect(restoreNeutralized("'일반")).toBe("'일반");
  });
});
