import { describe, expect, it } from 'vitest';
import { dateToYmd, excelSerialToDate, normalizeDate } from './dates';

describe('excelSerialToDate', () => {
  it('converts known serials, including the 1900 leap-year quirk', () => {
    expect(excelSerialToDate(1)).toBe('1900-01-01');
    expect(excelSerialToDate(59)).toBe('1900-02-28');
    expect(excelSerialToDate(61)).toBe('1900-03-01');
    expect(excelSerialToDate(25569)).toBe('1970-01-01');
    expect(excelSerialToDate(45292)).toBe('2024-01-01');
    expect(excelSerialToDate(45292.75)).toBe('2024-01-01');
  });

  it('rejects the nonexistent 1900-02-29 and out-of-range values', () => {
    expect(excelSerialToDate(60)).toBeNull();
    expect(excelSerialToDate(0)).toBeNull();
    expect(excelSerialToDate(-5)).toBeNull();
    expect(excelSerialToDate(Number.NaN)).toBeNull();
    expect(excelSerialToDate(3_000_000)).toBeNull();
  });
});

describe('normalizeDate', () => {
  it('accepts the common formats', () => {
    expect(normalizeDate('2024-03-05')).toBe('2024-03-05');
    expect(normalizeDate('2024.3.5')).toBe('2024-03-05');
    expect(normalizeDate('2024/03/05')).toBe('2024-03-05');
    expect(normalizeDate('20240305')).toBe('2024-03-05');
    expect(normalizeDate('2024년 3월 5일')).toBe('2024-03-05');
    expect(normalizeDate('2024-03-05T09:30:00Z')).toBe('2024-03-05');
    expect(normalizeDate(' 45292 ')).toBe('2024-01-01');
  });

  it('rejects impossible or unknown dates', () => {
    expect(normalizeDate('2024-02-30')).toBeNull();
    expect(normalizeDate('2023-02-29')).toBeNull();
    expect(normalizeDate('2024-13-01')).toBeNull();
    expect(normalizeDate('20241301')).toBeNull();
    expect(normalizeDate('어제')).toBeNull();
    expect(normalizeDate('')).toBeNull();
    expect(normalizeDate('0000-01-01')).toBeNull();
  });

  it('accepts a leap day', () => {
    expect(normalizeDate('2024-02-29')).toBe('2024-02-29');
  });
});

describe('dateToYmd', () => {
  it('uses the UTC calendar day and rejects invalid dates', () => {
    expect(dateToYmd(new Date(Date.UTC(2024, 0, 31)))).toBe('2024-01-31');
    expect(dateToYmd(new Date('invalid'))).toBeNull();
  });
});
