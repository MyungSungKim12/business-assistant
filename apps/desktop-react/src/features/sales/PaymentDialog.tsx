import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Select, confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { salesApi, type PaymentPart } from './api';
import { cents, formatWon, kst, methodLabel, newOperationId, wonInteger } from './format';
import { useRecoverableOperation, useRecoveryKey } from './recovery';
import type { CartBundle, CartLine, VisitPayments } from './types';

type Tab = 'record' | 'refund' | 'return';
const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

type RecordPayload = { operation_id: string; expected_version: number; payments: PaymentPart[]; confirmed: true };
function validateRecord(value: unknown): RecordPayload | null {
  if (!isObject(value) || typeof value.operation_id !== 'string' || !uuidLike.test(value.operation_id) || !Number.isInteger(value.expected_version) || (value.expected_version as number) < 1 || value.confirmed !== true) return null;
  if (!Array.isArray(value.payments) || value.payments.length < 1 || value.payments.length > 3) return null;
  for (const part of value.payments) {
    if (!isObject(part) || !['cash', 'card', 'transfer'].includes(String(part.method)) || typeof part.amount !== 'string' || !wonInteger.test(part.amount) || typeof part.reference !== 'string') return null;
  }
  return value as unknown as RecordPayload;
}
type RefundPayload = { operation_id: string; expected_version: number; source_id: string; amount: string; reason: string; confirmed: true };
function validateRefund(value: unknown): RefundPayload | null {
  if (!isObject(value) || !uuidLike.test(String(value.operation_id)) || !uuidLike.test(String(value.source_id)) || typeof value.amount !== 'string' || !wonInteger.test(value.amount)
    || typeof value.reason !== 'string' || !value.reason.trim() || !Number.isInteger(value.expected_version) || (value.expected_version as number) < 1 || value.confirmed !== true) return null;
  return value as unknown as RefundPayload;
}
type ReturnPayload = RefundPayload & { sale_line_id: string; receipt_id: string; quantity: number; restock: boolean };
function validateReturn(value: unknown): ReturnPayload | null {
  const base = validateRefund(isObject(value) ? { ...value, source_id: value.receipt_id } : value);
  if (!base || !isObject(value) || !uuidLike.test(String(value.sale_line_id)) || !Number.isInteger(value.quantity) || (value.quantity as number) < 1 || (value.quantity as number) > 999 || typeof value.restock !== 'boolean') return null;
  return value as unknown as ReturnPayload;
}

function refundedBySource(snapshot: VisitPayments): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const refund of snapshot.refunds) totals.set(refund.source_id, (totals.get(refund.source_id) ?? 0n) + (cents(refund.amount) ?? 0n));
  return totals;
}

interface FormProps {
  api: ApiClient; organizationId: string; visitId: string; snapshot: VisitPayments; canManage: boolean;
  onChanged: (result: VisitPayments) => void; onDirty: (dirty: boolean) => void;
}

function RecoveryNotice({ op, onRetry, canManage, label }: { op: { pending: unknown; invalid: boolean; message: string; busy: boolean }; onRetry: () => void; canManage: boolean; label: string }) {
  return <>
    {op.invalid && <p role="alert" className="form-error">보관된 복구 정보를 읽을 수 없어 새 요청을 잠갔습니다. 관리자 점검이 필요합니다.</p>}
    {op.message && <p role="alert" className="form-error">{op.message}</p>}
    {op.pending != null && <div className="sales-pending"><p>미확인 요청이 있습니다. 같은 요청으로 결과를 확인하세요.</p>{canManage && <button type="button" disabled={op.busy} onClick={onRetry}>{label}</button>}</div>}
  </>;
}

function RecordForm({ api, organizationId, visitId, snapshot, canManage, onChanged, onDirty }: FormProps) {
  const recovery = useRecoveryKey('payment', organizationId, visitId);
  const op = useRecoverableOperation<RecordPayload, VisitPayments>({
    ...recovery, validate: validateRecord,
    execute: (payload) => salesApi.recordPayment(api, organizationId, visitId, payload),
    onSuccess: (result) => { setValues(blank()); setConfirmed(false); setError(''); onChanged(result); notify.success('수납을 기록했습니다.'); },
    rejected: '수납이 거절되었습니다. 입력은 유지했습니다. 권한·금액·확인 번호를 확인하고 내역을 새로고침하세요.',
    unconfirmed: '수납 결과가 아직 확인되지 않았습니다. 원래 계정으로 로그인한 뒤 ‘미확인 수납 다시 확인’을 눌러주세요.',
  });
  const blank = () => ({ cash: { amount: '', reference: '' }, card: { amount: '', reference: '' }, transfer: { amount: '', reference: '' } });
  const fromPending = (): ReturnType<typeof blank> => {
    const next = blank();
    for (const part of op.pending?.payments ?? []) next[part.method] = { amount: part.amount, reference: part.reference };
    return next;
  };
  const [values, setValues] = useState(fromPending);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const dirty = confirmed || Object.values(values).some((pair) => pair.amount || pair.reference);
  useEffect(() => onDirty(dirty && op.pending == null), [dirty, op.pending, onDirty]);
  const payable = snapshot.status === 'ready' || snapshot.status === 'collecting';
  const locked = !canManage || op.busy || op.pending != null || op.invalid;

  async function save() {
    if (locked || !payable) return;
    const total = cents(snapshot.total_amount);
    if (total === null || total % 100n !== 0n) { setError('원 미만 청구액이 있습니다. 장바구니에서 금액을 정정하세요.'); return; }
    const payments: PaymentPart[] = [];
    for (const method of ['cash', 'card', 'transfer'] as const) {
      const amount = values[method].amount.trim();
      const reference = values[method].reference.trim();
      if (!amount) { if (reference) { setError('확인 번호를 입력한 수단의 금액도 입력하세요.'); return; } continue; }
      if (!wonInteger.test(amount)) { setError('금액은 0보다 큰 원 단위 숫자로 입력하세요.'); return; }
      if (method !== 'cash' && !reference) { setError('카드 승인번호 또는 이체 식별번호가 필요합니다.'); return; }
      payments.push({ method, amount, reference });
    }
    if (payments.length === 0 || !confirmed) { setError('금액을 입력하고 실제 수납 확인을 체크하세요.'); return; }
    const sum = payments.reduce((acc, part) => acc + BigInt(part.amount), 0n);
    if (sum * 100n > (cents(snapshot.outstanding_amount) ?? 0n)) { setError('입력한 수납액이 남은 미수금보다 큽니다.'); return; }
    setError('');
    await op.submit({ operation_id: newOperationId(), expected_version: snapshot.cart_version, payments, confirmed: true });
  }

  const rows: Array<['cash' | 'card' | 'transfer', string, string]> = [['cash', '현금', '메모 (선택)'], ['card', '카드', '승인번호 (필수)'], ['transfer', '이체', '이체 식별번호 (필수)']];
  return <div className="sales-form">
    {rows.map(([method, label, hint]) => <div className="sales-form__row" key={method}>
      <label>{label} 금액<input inputMode="numeric" maxLength={12} placeholder="받은 금액 (원)" disabled={locked || !payable} value={values[method].amount} onChange={(e) => setValues({ ...values, [method]: { ...values[method], amount: e.target.value } })} /></label>
      <label>{label} {method === 'cash' ? '메모' : method === 'card' ? '승인번호' : '식별번호'}<input maxLength={200} placeholder={hint} disabled={locked || !payable} value={values[method].reference} onChange={(e) => setValues({ ...values, [method]: { ...values[method], reference: e.target.value } })} /></label>
    </div>)}
    <label className="sales-check"><input type="checkbox" disabled={locked || !payable} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />위 금액을 실제로 받았음을 확인했습니다.</label>
    {error && <p role="alert" className="form-error">{error}</p>}
    <RecoveryNotice op={op} onRetry={op.retry} canManage={canManage} label="미확인 수납 다시 확인" />
    {canManage && <div className="sales-actions"><button type="button" className="primary-button" disabled={locked || !payable} onClick={() => void save()}>수납 기록 저장</button></div>}
    {!payable && <p className="muted">장바구니 검토 완료 후에 수납을 기록할 수 있습니다.</p>}
  </div>;
}

function RefundForm({ api, organizationId, visitId, snapshot, canManage, onChanged, onDirty }: FormProps) {
  const recovery = useRecoveryKey('refund', organizationId, visitId);
  const op = useRecoverableOperation<RefundPayload, VisitPayments>({
    ...recovery, validate: validateRefund,
    execute: (payload) => salesApi.refund(api, organizationId, visitId, payload),
    onSuccess: (result) => { setAmount(''); setReason(''); setConfirmed(false); setError(''); onChanged(result); notify.success('환불 반대 원장을 기록했습니다.'); },
    rejected: '환불 기록이 거절되었습니다. 최신 내역을 다시 확인하세요.',
    unconfirmed: '환불 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하세요.',
  });
  const refunded = refundedBySource(snapshot);
  const candidates = snapshot.receipts.map((receipt) => ({ receipt, available: (cents(receipt.amount) ?? 0n) - (refunded.get(receipt.id) ?? 0n) })).filter((item) => item.available > 0n);
  const [sourceId, setSourceId] = useState(op.pending?.source_id ?? '');
  const [amount, setAmount] = useState(op.pending?.amount ?? '');
  const [reason, setReason] = useState(op.pending?.reason ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const dirty = Boolean(amount || reason || confirmed);
  useEffect(() => onDirty(dirty && op.pending == null), [dirty, op.pending, onDirty]);
  const selected = candidates.find((item) => item.receipt.id === sourceId) ?? candidates[0];
  const locked = !canManage || op.busy || op.pending != null || op.invalid;

  async function save() {
    if (locked || !selected) return;
    const text = amount.trim();
    const why = reason.trim();
    if (!wonInteger.test(text) || !why || why.length > 1000 || !confirmed) { setError('환불 금액, 사유와 확인 항목을 확인하세요.'); return; }
    const value = BigInt(text) * 100n;
    if (value > selected.available || (selected.receipt.method === 'wallet' && value !== selected.available)) { setError('원거래의 환불 가능 금액 안에서 입력하세요. 회원권 사용은 전체 취소만 가능합니다.'); return; }
    setError('');
    await op.submit({ operation_id: newOperationId(), expected_version: snapshot.cart_version, source_id: selected.receipt.id, amount: text, reason: why, confirmed: true });
  }
  if (snapshot.receipts.length === 0) return <p className="muted">환불할 수납 내역이 없습니다.</p>;
  return <div className="sales-form">
    <p className="muted">외부 카드사·은행 취소를 실행하지 않습니다. 실제 취소를 확인한 뒤 기록하세요.</p>
    <label>환불 대상 원거래
      <Select aria-label="환불 대상 원거래" disabled={locked} value={selected?.receipt.id ?? ''} onChange={setSourceId}
        options={candidates.map(({ receipt, available }) => ({ value: receipt.id, label: `${methodLabel[receipt.method]} · 환불 가능 ${formatWon(available / 100n)} · ${receipt.reference}` }))} />
    </label>
    <label>환불 금액<input inputMode="numeric" maxLength={12} placeholder="환불 금액 (원)" disabled={locked} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
    <label>환불 사유<input maxLength={1000} disabled={locked} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    <label className="sales-check"><input type="checkbox" disabled={locked} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />외부 취소 여부와 환불 대상을 확인했습니다.</label>
    {error && <p role="alert" className="form-error">{error}</p>}
    <RecoveryNotice op={op} onRetry={op.retry} canManage={canManage} label="미확인 환불 다시 확인" />
    {canManage && <div className="sales-actions"><button type="button" className="primary-button" disabled={locked || !selected} onClick={() => void save()}>환불 기록</button></div>}
  </div>;
}

/** 반품 환불 한도: min(단가×수량 − 할인 증가분, 남은 순판매가). 반올림은 원 단위 half-up. */
export function returnLimit(line: CartLine, quantity: number): bigint {
  const sold = BigInt(line.quantity);
  const after = BigInt(line.returned_quantity + quantity);
  const share = BigInt((cents(line.discount_share ?? '0') ?? 0n) / 100n);
  const prior = BigInt((cents(line.returned_discount_amount ?? '0') ?? 0n) / 100n);
  const discountAfter = after === sold ? share : (2n * share * after + sold) / (2n * sold);
  const increment = (discountAfter - prior) * 100n;
  const unit = cents(line.unit_price) ?? 0n;
  const remainingNet = (cents(line.line_total) ?? 0n) - share * 100n - (cents(line.returned_refund_amount ?? '0') ?? 0n);
  const gross = unit * BigInt(quantity) - increment;
  return gross < remainingNet ? gross : remainingNet;
}

function ReturnForm({ api, organizationId, visitId, snapshot, canManage, onChanged, onDirty, cart }: FormProps & { cart: CartBundle | null }) {
  const recovery = useRecoveryKey('return', organizationId, visitId);
  const op = useRecoverableOperation<ReturnPayload, VisitPayments>({
    ...recovery, validate: validateReturn,
    execute: (payload) => salesApi.productReturn(api, organizationId, visitId, payload),
    onSuccess: (result) => { setAmount(''); setReason(''); setConfirmed(false); setError(''); onChanged(result); notify.success('반품과 환불을 기록했습니다.'); },
    rejected: '반품 기록이 거절되었습니다. 최신 내역을 다시 확인하세요.',
    unconfirmed: '반품 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.',
  });
  const lines = (cart?.lines ?? []).filter((line) => line.source_type === 'product' && line.status === 'active' && line.quantity - line.returned_quantity > 0);
  const refunded = refundedBySource(snapshot);
  const receipts = snapshot.receipts.map((receipt) => ({ receipt, available: (cents(receipt.amount) ?? 0n) - (refunded.get(receipt.id) ?? 0n) }))
    .filter((item) => item.receipt.method !== 'wallet' && item.available > 0n);
  const [lineId, setLineId] = useState(op.pending?.sale_line_id ?? '');
  const [receiptId, setReceiptId] = useState(op.pending?.receipt_id ?? '');
  const [quantity, setQuantity] = useState(String(op.pending?.quantity ?? 1));
  const [amount, setAmount] = useState(op.pending?.amount ?? '');
  const [reason, setReason] = useState(op.pending?.reason ?? '');
  const [restock, setRestock] = useState(op.pending?.restock ?? true);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const dirty = Boolean(amount || reason || confirmed);
  useEffect(() => onDirty(dirty && op.pending == null), [dirty, op.pending, onDirty]);
  const line = lines.find((item) => item.id === lineId) ?? lines[0];
  const receipt = receipts.find((item) => item.receipt.id === receiptId) ?? receipts[0];
  const locked = !canManage || op.busy || op.pending != null || op.invalid;

  async function save() {
    if (locked || !line || !receipt) { setError('반품 가능한 상품과 환불 가능한 원결제 내역이 필요합니다.'); return; }
    const qty = Number(quantity);
    const text = amount.trim();
    const why = reason.trim();
    const ok = Number.isInteger(qty) && qty >= 1 && qty <= line.quantity - line.returned_quantity && wonInteger.test(text) && why.length > 0 && why.length <= 1000 && confirmed;
    if (!ok) { setError('반품 수량, 원결제 잔액, 상품 금액, 사유와 확인 항목을 점검하세요.'); return; }
    const value = BigInt(text) * 100n;
    if (value > receipt.available || value > returnLimit(line, qty)) { setError('반품 수량, 원결제 잔액, 상품 금액, 사유와 확인 항목을 점검하세요.'); return; }
    setError('');
    await op.submit({ operation_id: newOperationId(), expected_version: snapshot.cart_version, sale_line_id: line.id, receipt_id: receipt.receipt.id, quantity: qty, restock, amount: text, reason: why, source_id: receipt.receipt.id, confirmed: true } as ReturnPayload);
  }
  if (lines.length === 0 && op.pending == null) return <p className="muted">반품 가능한 판매 상품이 없습니다.</p>;
  return <div className="sales-form">
    <p className="muted">반품 수량, 원결제 수단의 환불 금액, 재입고 여부를 함께 기록합니다. 실제 카드·은행 취소는 별도로 완료한 뒤 진행하세요.</p>
    <label>반품 상품<Select aria-label="반품 상품" disabled={locked} value={line?.id ?? ''} onChange={setLineId} options={lines.map((item) => ({ value: item.id, label: `${item.description_snapshot} · 최대 ${item.quantity - item.returned_quantity}개` }))} /></label>
    <label>원결제<Select aria-label="원결제" disabled={locked} value={receipt?.receipt.id ?? ''} onChange={setReceiptId} options={receipts.map(({ receipt: r, available }) => ({ value: r.id, label: `${methodLabel[r.method]} · 잔여 ${formatWon(available / 100n)} · ${r.reference}` }))} /></label>
    <label>반품 수량<input inputMode="numeric" disabled={locked} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
    <label>환불 금액<input inputMode="numeric" maxLength={12} placeholder="환불 금액 (원)" disabled={locked} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
    <label>반품 사유<input maxLength={1000} disabled={locked} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    <label className="sales-check"><input type="checkbox" disabled={locked} checked={restock} onChange={(e) => setRestock(e.target.checked)} />반품 상품 재입고</label>
    <label className="sales-check"><input type="checkbox" disabled={locked} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />반품 상품과 원결제 환불 처리, 실제 외부 취소 상태를 확인했습니다.</label>
    {error && <p role="alert" className="form-error">{error}</p>}
    <RecoveryNotice op={op} onRetry={op.retry} canManage={canManage} label="미확인 반품 다시 확인" />
    {canManage && <div className="sales-actions"><button type="button" className="primary-button" disabled={locked} onClick={() => void save()}>반품·환불 기록</button></div>}
  </div>;
}

export function PaymentDialog({ api, organizationId, visitId, canManage, onClose }: { api: ApiClient; organizationId: string; visitId: string; canManage: boolean; onClose: (changed: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<VisitPayments | null>(null);
  const [cart, setCart] = useState<CartBundle | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('record');
  const [changed, setChanged] = useState(false);
  const dirty = useRef<Record<string, boolean>>({});
  const onDirty = useCallback((kind: Tab) => (value: boolean) => { dirty.current[kind] = value; }, []);
  const dirtyRecord = useRef(onDirty('record')).current;
  const dirtyRefund = useRef(onDirty('refund')).current;
  const dirtyReturn = useRef(onDirty('return')).current;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [payments, bundle] = await Promise.all([salesApi.payments(api, organizationId, visitId), salesApi.cart(api, organizationId, visitId).catch(() => null)]);
      setSnapshot(payments);
      setCart(bundle);
    } catch { setError('수납 내역을 불러오지 못했습니다. 다시 조회해 주세요.'); } finally { setLoading(false); }
  }, [api, organizationId, visitId]);
  useEffect(() => { void load(); }, [load]);

  const changedResult = useCallback((result: VisitPayments) => { setSnapshot(result); setChanged(true); void salesApi.cart(api, organizationId, visitId).then(setCart).catch(() => undefined); }, [api, organizationId, visitId]);
  async function close() {
    if (Object.values(dirty.current).some(Boolean) && !await confirm({ title: '작성 중인 내용', message: '저장하지 않은 입력을 버릴까요?', confirmLabel: '버리기', tone: 'danger' })) return;
    onClose(changed);
  }
  const closeRef = useRef(close);
  closeRef.current = close;
  const stableClose = useCallback(() => { void closeRef.current(); }, []);

  const voided = snapshot?.status === 'void';
  return <Modal title="수납 기록 · 환불" size="lg" onClose={stableClose}>
    <p className="muted">실제로 받은 금액만 기록하세요. 카드 승인이나 계좌 이체를 실행하는 기능은 아닙니다. 첫 수납 이후에는 청구 항목을 변경할 수 없습니다. 금액은 원 단위입니다.</p>
    {loading && <p role="status">수납 내역을 불러오는 중…</p>}
    {error && <div role="alert" className="form-error">{error} <button type="button" onClick={() => void load()}>다시 시도</button></div>}
    {snapshot && <>
      <p className="sales-balance" data-testid="payment-balance">{voided
        ? `청구 ${formatWon(snapshot.total_amount)} · 순수납 ${formatWon(snapshot.paid_amount)} · 환불 ${formatWon(snapshot.refunded_amount)} · 취소 잔액 ${formatWon(snapshot.outstanding_amount)}`
        : `청구 ${formatWon(snapshot.total_amount)} · 수납 ${formatWon(snapshot.paid_amount)} · 미수 ${formatWon(snapshot.outstanding_amount)}`}</p>
      <div className="sales-tabs" role="tablist">
        {([['record', '수납 기록'], ['refund', '환불 · 사용 취소'], ['return', '상품 반품']] as const).map(([id, label]) =>
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === 'record' && <RecordForm api={api} organizationId={organizationId} visitId={visitId} snapshot={snapshot} canManage={canManage} onChanged={changedResult} onDirty={dirtyRecord} />}
      {tab === 'refund' && <RefundForm api={api} organizationId={organizationId} visitId={visitId} snapshot={snapshot} canManage={canManage} onChanged={changedResult} onDirty={dirtyRefund} />}
      {tab === 'return' && <ReturnForm api={api} organizationId={organizationId} visitId={visitId} snapshot={snapshot} canManage={canManage} onChanged={changedResult} onDirty={dirtyReturn} cart={cart} />}
      <div className="data-surface sales-history"><table><caption>수납 내역</caption><thead><tr><th>수납일 (한국시간)</th><th>수단</th><th>금액</th><th>확인 번호</th></tr></thead>
        <tbody>{snapshot.receipts.map((receipt) => <tr key={receipt.id}><td>{kst(receipt.received_at)}</td><td>{methodLabel[receipt.method]}</td><td>{formatWon(receipt.amount)}</td><td>{receipt.reference}</td></tr>)}</tbody></table>
        {snapshot.receipts.length === 0 && <p className="empty-state">수납 내역이 없습니다.</p>}
      </div>
      {snapshot.refunds.length > 0 && <div className="data-surface sales-history"><table><caption>환불 내역</caption><thead><tr><th>환불일 (한국시간)</th><th>금액</th><th>사유</th></tr></thead>
        <tbody>{snapshot.refunds.map((refund) => <tr key={refund.id}><td>{kst(refund.created_at)}</td><td>{formatWon(refund.amount)}</td><td>{refund.reason}</td></tr>)}</tbody></table></div>}
    </>}
    <div className="sales-actions"><button type="button" onClick={() => void load()}>내역 새로고침</button><button type="button" onClick={stableClose}>닫기</button></div>
  </Modal>;
}
