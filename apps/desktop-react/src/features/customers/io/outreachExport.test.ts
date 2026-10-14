import { describe, expect, it } from 'vitest';
import { birthdayCustomers, lapsedCustomers } from '../insights';
import type { Customer } from '../types';
import { birthdayExportColumns, lapsedExportColumns } from './outreachExport';

const base = { organization_id: '22222222-2222-4222-8222-222222222222', email: null, notes: '메모', skin_type: null, concerns: [], allergies: '', next_visit_date: null, tags: ['VIP'], status: 'active' } as const;
const customers = [
  { ...base, id: '1', name: '오래됨', phone: '010-1111-2222', birth_date: null, last_visit_date: '2026-01-01', marketing_consent: true },
  { ...base, id: '2', name: '기록없음', phone: '', birth_date: '1990-10-20', last_visit_date: null },
] as unknown as Customer[];

describe('연락 대상 내보내기 열', () => {
  it('장기 미방문 명단에 연락처·경과 일수·수신 동의 여부가 들어간다', () => {
    const rows = lapsedCustomers(customers, '2026-10-14');
    const cells = rows.map((row) => lapsedExportColumns.map((column) => column.value(row)));
    expect(lapsedExportColumns.map((column) => column.header)).toEqual(['이름', '연락처', '마지막 방문일', '경과 일수', '다음 방문일', '태그', '메모', '마케팅 수신']);
    expect(cells[0]).toEqual(['오래됨', '010-1111-2222', '2026-01-01', 286, null, 'VIP', '메모', '동의']);
    expect(cells[1][2]).toBeNull();
    expect(cells[1][3]).toBeNull();
  });

  it('이번 달 생일 명단은 날짜 순이고 수신 동의 여부를 포함한다', () => {
    const rows = birthdayCustomers(customers, '2026-10-14');
    expect(rows).toHaveLength(1);
    expect(birthdayExportColumns.map((column) => column.value(rows[0]))).toEqual(['기록없음', '', '1990-10-20', null, 'VIP', '미동의']);
  });
});
