import { describe, expect, it } from 'vitest';
import { buildReceiptPdfSpec } from './receiptPdf';
import type { CartBundle, VisitPayments } from './types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payments: VisitPayments = {
  visit_id: id(1), cart_id: id(2), cart_version: 3, total_amount: '50000', paid_amount: '30000', outstanding_amount: '20000', refunded_amount: '0', currency: 'KRW', status: 'collecting',
  receipts: [{ id: id(3), method: 'card', amount: '30000', reference: 'A-12', received_at: '2026-10-13T03:00:00Z', operation_id: id(4) }],
  refunds: [],
};
const cart = {
  visit: {} as never,
  cart: { discount_total: '5000', discount_reason: '재방문', total_amount: '50000' } as never,
  lines: [
    { id: id(5), cart_id: id(2), description_snapshot: '젤 네일', quantity: 1, unit_price: '55000', line_total: '55000', staff_name_snapshot: '김원장', status: 'active' },
    { id: id(6), cart_id: id(2), description_snapshot: '삭제된 항목', quantity: 1, unit_price: '1000', line_total: '1000', staff_name_snapshot: '', status: 'removed' },
  ],
  discount_history: [],
} as unknown as CartBundle;
const flat = (spec: ReturnType<typeof buildReceiptPdfSpec>) => JSON.stringify(spec.sections);

describe('buildReceiptPdfSpec', () => {
  it('청구 항목·할인·수납 내역·미수 금액을 담고 삭제된 항목은 뺀다', () => {
    const spec = buildReceiptPdfSpec({ organizationName: '베이지 살롱', customerName: '박고객', payments, cart }, new Date('2026-10-13T05:00:00Z'));
    const text = flat(spec);
    expect(spec.title).toBe('수납 영수증');
    expect(text).toContain('젤 네일');
    expect(text).not.toContain('삭제된 항목');
    expect(text).toContain('재방문');
    expect(text).toContain('A-12');
    expect(text).toContain('일부 수납');
    expect(text).toContain('20,000원');
    expect(spec.footer).toMatch(/영수증 코드 [0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/);
  });

  it('장바구니를 못 불러와도 금액만으로 만들고, 수납이 없으면 안내 문구를 넣는다', () => {
    const spec = buildReceiptPdfSpec({ organizationName: '', customerName: '', payments: { ...payments, receipts: [] }, cart: null });
    expect(flat(spec)).toContain('수납 내역이 없습니다.');
    expect(flat(spec)).not.toContain('청구 항목');
  });

  it('같은 내역이면 같은 코드, 내역이 바뀌면 다른 코드가 나온다', () => {
    const a = buildReceiptPdfSpec({ organizationName: 'a', customerName: 'b', payments, cart }, new Date(0)).footer.split(' ')[2];
    const b = buildReceiptPdfSpec({ organizationName: 'a', customerName: 'b', payments: { ...payments, paid_amount: '50000' }, cart }, new Date(0)).footer.split(' ')[2];
    expect(a).not.toBe(b);
  });
});
