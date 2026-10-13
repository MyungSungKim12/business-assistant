import type { AppointmentServiceRow } from '../appointment-resources/schemas';

export type ServiceForm = { name: string; category: string; price: string; duration: string; buffer: string; is_active: boolean };
export type ServiceValues = { name: string; category: string; price_krw: number; duration_minutes: number; buffer_minutes: number; is_active: boolean };

export const emptyServiceForm = (): ServiceForm => ({ name: '', category: '', price: '0', duration: '60', buffer: '10', is_active: true });
export const serviceToForm = (row: AppointmentServiceRow): ServiceForm => ({
  name: row.name, category: row.category, price: String(row.price_krw), duration: String(row.duration_minutes), buffer: String(row.buffer_minutes), is_active: row.is_active,
});

const WHOLE = /^\d+$/;
const MAX_PRICE = 1_000_000_000;

/** 입력을 서버 요청 값으로 바꾼다. 서버가 다시 검증하지만 같은 범위를 먼저 안내한다. 잘못된 값은 오류 문구. */
export function parseServiceForm(form: ServiceForm): ServiceValues | string {
  const name = form.name.trim();
  const category = form.category.trim();
  const priceText = form.price.trim() === '' ? '0' : form.price.trim();
  const duration = Number(form.duration);
  const buffer = Number(form.buffer);
  if (!name) return '서비스명을 입력하세요.';
  if (name.length > 160) return '서비스명은 160자 이하로 입력하세요.';
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) return '소요 시간은 5~480분이어야 합니다.';
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 120) return '여유 시간은 0~120분이어야 합니다.';
  if (!WHOLE.test(priceText) || Number(priceText) > MAX_PRICE) return '가격은 0원 이상의 정수(원 단위)여야 합니다.';
  if (category.length > 60) return '카테고리는 60자 이하로 입력하세요.';
  return { name, category, price_krw: Number(priceText), duration_minutes: duration, buffer_minutes: buffer, is_active: form.is_active };
}

export type ServiceStatusFilter = 'all' | 'active' | 'inactive';
export type ServiceFilter = { query: string; status: ServiceStatusFilter };

/** 이름·카테고리 검색과 사용 여부로 목록을 거른다. */
export function filterServices(rows: AppointmentServiceRow[], filter: ServiceFilter): AppointmentServiceRow[] {
  const needle = filter.query.trim().toLowerCase();
  return rows.filter((row) => (filter.status === 'all' || (filter.status === 'active') === row.is_active)
    && (needle === '' || `${row.name} ${row.category}`.toLowerCase().includes(needle)));
}

/** 입력 자동완성용 기존 카테고리(중복 제거, 가나다순). */
export const serviceCategories = (rows: AppointmentServiceRow[]): string[] =>
  [...new Set(rows.map((row) => row.category).filter((category) => category !== ''))].sort((a, b) => a.localeCompare(b, 'ko'));
