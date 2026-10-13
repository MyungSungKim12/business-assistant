import { describe, expect, it } from 'vitest';
import type { AppointmentServiceRow } from '../appointment-resources/schemas';
import { emptyServiceForm, filterServices, parseServiceForm, serviceCategories, serviceToForm } from './serviceForm';

const row = (over: Partial<AppointmentServiceRow> = {}): AppointmentServiceRow => ({
  id: 's1', organization_id: 'o', name: '관리', duration_minutes: 60, buffer_minutes: 10, is_active: true, resource_version: 1, price_krw: 50000, category: '피부', service_version: 2, ...over,
});

describe('parseServiceForm', () => {
  const base = { ...emptyServiceForm(), name: ' 레이저 ', category: ' 피부 ', price: '50000' };
  it('공백을 정리해 서버 값으로 바꾼다', () => {
    expect(parseServiceForm(base)).toEqual({ name: '레이저', category: '피부', price_krw: 50000, duration_minutes: 60, buffer_minutes: 10, is_active: true });
  });
  it('가격을 비우면 0원, 카테고리는 비워도 된다', () => {
    expect(parseServiceForm({ ...base, price: '', category: '' })).toMatchObject({ price_krw: 0, category: '' });
  });
  it.each([
    [{ name: ' ' }, '서비스명을 입력하세요.'],
    [{ duration: '4' }, '소요 시간은 5~480분이어야 합니다.'],
    [{ duration: '60.5' }, '소요 시간은 5~480분이어야 합니다.'],
    [{ buffer: '121' }, '여유 시간은 0~120분이어야 합니다.'],
    [{ price: '-1' }, '가격은 0원 이상의 정수(원 단위)여야 합니다.'],
    [{ price: '1.5' }, '가격은 0원 이상의 정수(원 단위)여야 합니다.'],
    [{ price: '1000000001' }, '가격은 0원 이상의 정수(원 단위)여야 합니다.'],
    [{ category: 'x'.repeat(61) }, '카테고리는 60자 이하로 입력하세요.'],
  ])('잘못된 입력 %j 은 안내 문구를 돌려준다', (change, message) => {
    expect(parseServiceForm({ ...base, ...change })).toBe(message);
  });
});

describe('목록 도우미', () => {
  const rows = [row(), row({ id: 's2', name: '바디 마사지', category: '바디', is_active: false }), row({ id: 's3', name: '필링', category: '피부' })];
  it('검색(이름·카테고리)과 상태로 거른다', () => {
    const ids = (query: string, status: 'all' | 'active' | 'inactive') => filterServices(rows, { query, status }).map((item) => item.id);
    expect(ids('', 'all')).toEqual(['s1', 's2', 's3']);
    expect(ids('피부', 'all')).toEqual(['s1', 's3']);
    expect(ids('', 'inactive')).toEqual(['s2']);
    expect(ids('바디', 'active')).toEqual([]);
  });
  it('폼 변환과 카테고리 목록', () => {
    expect(serviceToForm(rows[0])).toEqual({ name: '관리', category: '피부', price: '50000', duration: '60', buffer: '10', is_active: true });
    expect(serviceCategories([...rows, row({ id: 's4', category: '' })])).toEqual(['바디', '피부']);
  });
});
