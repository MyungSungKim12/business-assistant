import { renderPdf, savePdf, sha256Hex, type PdfSection, type PdfSpec } from '../../lib/pdf';
import { formatWon, kst, methodLabel } from './format';
import type { CartBundle, VisitPayments } from './types';

export interface ReceiptInput {
  organizationName: string;
  customerName: string;
  payments: VisitPayments;
  /** 청구 항목. 장바구니를 불러오지 못했으면 항목 없이 금액만 인쇄한다. */
  cart: CartBundle | null;
}

const statusLabel: Record<VisitPayments['status'], string> = { draft: '작성 중', ready: '결제 대기', collecting: '일부 수납', paid: '수납 완료', void: '취소됨' };

/** 수납 영수증(UX-04). 앱이 기록한 수납·환불 내역을 정리한 안내용 문서이며 현금영수증·세금계산서가 아니다. */
export function buildReceiptPdfSpec({ organizationName, customerName, payments, cart }: ReceiptInput, now: Date = new Date()): PdfSpec {
  const lines = (cart?.lines ?? []).filter((line) => line.status === 'active');
  const sections: PdfSection[] = [
    { kind: 'heading', text: '방문 정보' },
    { kind: 'rows', rows: [['매장', organizationName || '매장'], ['고객', customerName || '고객'], ['상태', statusLabel[payments.status] ?? payments.status]] },
  ];
  if (lines.length > 0) {
    sections.push({ kind: 'heading', text: '청구 항목' }, { kind: 'rows', rows: lines.map((line) => {
      const staff = line.staff_name_snapshot ? ` · 담당 ${line.staff_name_snapshot}` : '';
      return [line.description_snapshot, `${formatWon(line.unit_price)} × ${line.quantity} = ${formatWon(line.line_total)}${staff}`] as [string, string];
    }) });
    if (cart && cart.cart.discount_total !== '0' && cart.cart.discount_total !== '0.00') sections.push({ kind: 'rows', rows: [['할인', `-${formatWon(cart.cart.discount_total)}${cart.cart.discount_reason ? ` (${cart.cart.discount_reason})` : ''}`]] });
  }
  sections.push({ kind: 'heading', text: '결제 요약' }, { kind: 'rows', rows: [
    ['청구 금액', formatWon(payments.total_amount)], ['수납 금액', formatWon(payments.paid_amount)], ['환불 금액', formatWon(payments.refunded_amount)], ['미수 금액', formatWon(payments.outstanding_amount)],
  ] });
  sections.push({ kind: 'heading', text: '수납 내역' });
  sections.push(payments.receipts.length > 0
    ? { kind: 'rows', rows: payments.receipts.map((receipt) => [`${kst(receipt.received_at)} · ${methodLabel[receipt.method]}`, `${formatWon(receipt.amount)}${receipt.reference ? ` · 확인 ${receipt.reference}` : ''}`] as [string, string]) }
    : { kind: 'paragraph', text: '수납 내역이 없습니다.', muted: true });
  if (payments.refunds.length > 0) {
    sections.push({ kind: 'heading', text: '환불 내역' }, { kind: 'rows', rows: payments.refunds.map((refund) => [kst(refund.created_at), `${formatWon(refund.amount)}${refund.reason ? ` · ${refund.reason}` : ''}`] as [string, string]) });
  }
  sections.push({ kind: 'paragraph', muted: true, text: '이 영수증은 매장 앱에 기록된 내역을 정리한 안내용 문서입니다. 현금영수증이나 세금계산서를 대신하지 않습니다.' });
  const code = sha256Hex(['receipt-v1', payments.cart_id, payments.cart_version, payments.total_amount, payments.paid_amount, payments.refunded_amount, ...payments.receipts.map((r) => r.id), ...payments.refunds.map((r) => r.id)].join('\n')).slice(0, 12).toUpperCase().match(/.{4}/g)!.join('-');
  return { title: '수납 영수증', subtitle: `${organizationName || '매장'} · ${customerName || '고객'}`, sections, footer: `영수증 코드 ${code} · ${kst(now.toISOString())} 발행`, createdAt: now };
}

export async function exportReceiptPdf(input: ReceiptInput): Promise<boolean> {
  const bytes = await renderPdf(buildReceiptPdfSpec(input));
  return savePdf(`영수증_${input.customerName || '고객'}`, bytes);
}
