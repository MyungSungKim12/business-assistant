import { useEffect, useState } from 'react';
import { Modal, Select, notify, confirm } from '@business-assistant/react-ui';
import { useDraftProtection } from '../../app/DraftBoundary';
import { useSessionStore } from '../../store/session';
import { useRecoverableOperation } from '../sales/recovery';
import type { ApiClient } from '../../api/client';
import { catalogApi } from './api';
import type { CatalogProduct } from './schemas';
import { purchaseOrdersSchema, suppliersSchema, purchaseOrderSchema } from './schemas';
import { z } from 'zod';

type Order = z.infer<typeof purchaseOrderSchema>;
type DraftLine = { product_id: string; quantity_ordered: string; unit_cost: string; note: string };
const emptyLine = (): DraftLine => ({ product_id: '', quantity_ordered: '1', unit_cost: '0', note: '' });
const receiptRequest = z.object({ order_id: z.uuid(), line_id: z.uuid(), quantity: z.number().int().positive(), operation_id: z.uuid(), expires_on: z.iso.date().nullable(), lot_code: z.string().max(120) });
const orderRequest = z.object({ supplier_id: z.uuid(), operation_id: z.uuid(), note: z.string(), lines: z.array(z.object({ product_id: z.uuid(), quantity_ordered: z.number().int().positive(), unit_cost: z.string(), note: z.string() })).min(1) });

export function PurchaseOrdersDialog({ api, organizationId, products, readOnly, onClose }: { api: ApiClient; organizationId: string; products: CatalogProduct[]; readOnly: boolean; onClose: () => void }) {
  const [suppliers, setSuppliers] = useState<z.infer<typeof suppliersSchema>>([]);
  const [orders, setOrders] = useState<z.infer<typeof purchaseOrdersSchema>>([]);
  const [supplierName, setSupplierName] = useState('');
  const [supplierContact, setSupplierContact] = useState('');
  const [supplierPhone, setSupplierPhone] = useState('');
  const [supplierEmail, setSupplierEmail] = useState('');
  const [supplierNote, setSupplierNote] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [working, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receiving, setReceiving] = useState<{ row: Order; line: Order['lines'][number] } | null>(null);
  const [quantity, setQuantity] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [lotCode, setLotCode] = useState('');
  const userId = useSessionStore(state => state.user?.user_id ?? 'local');
  const recoveryScope = `${userId}.${organizationId}`;
  const receipt = useRecoverableOperation({
    key: `ba.catalog.receipt.${recoveryScope}`,
    validate: value => { const result = receiptRequest.safeParse(value); return result.success ? result.data : null; },
    execute: payload => catalogApi.receivePurchaseOrderLine(api, organizationId, payload.order_id, payload.line_id, { quantity: payload.quantity, operation_id: payload.operation_id, expires_on: payload.expires_on, lot_code: payload.lot_code }),
    onSuccess: () => { setReceiving(null); setQuantity(''); setExpiresOn(''); setLotCode(''); void load(); notify.success('입고와 로트 정보를 반영했습니다.'); },
    rejected: '입고가 거절되었습니다. 발주 잔량과 권한을 확인하세요.',
    unconfirmed: '입고 결과를 확인하지 못했습니다. 수량을 변경하지 말고 같은 요청으로 다시 확인하세요.',
  });
  const creation = useRecoverableOperation({
    key: `ba.catalog.purchase.${recoveryScope}`,
    validate: value => { const result = orderRequest.safeParse(value); return result.success ? result.data : null; },
    execute: payload => catalogApi.createPurchaseOrder(api, organizationId, payload),
    onSuccess: saved => { setOrders(old => [saved, ...old.filter(row => row.id !== saved.id)]); setLines([emptyLine()]); setSupplierId(''); setError(''); },
    rejected: '발주가 거절되었습니다. 상품·공급처와 권한을 확인하세요.',
    unconfirmed: '발주 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.',
  });
  const busy = working || receipt.busy || creation.busy;
  const pending = Boolean(receipt.pending || creation.pending || receipt.invalid || creation.invalid);
  const draft = Boolean(supplierName || supplierContact || supplierPhone || supplierEmail || supplierNote || supplierId || receiving || lines.some(line => JSON.stringify(line) !== JSON.stringify(emptyLine())));
  useDraftProtection(draft || pending, busy);
  async function close() {
    if (busy) return;
    if ((draft || pending) && !(await confirm({ title: '작성 중인 발주·입고', message: pending ? '미확인 요청은 이 계정과 매장에 보관됩니다. 다음에 같은 요청으로 확인하세요. 입력 화면을 닫을까요?' : '저장하지 않은 입력이 있습니다. 버리고 닫을까요?', confirmLabel: '닫기', cancelLabel: '계속 작성' }))) return;
    onClose();
  }

  async function load() {
    try {
      const [nextSuppliers, nextOrders] = await Promise.all([catalogApi.listSuppliers(api, organizationId), catalogApi.listPurchaseOrders(api, organizationId)]);
      setSuppliers(nextSuppliers); setOrders(nextOrders); setError('');
    } catch { setError('공급처·발주 목록을 불러오지 못했습니다. 필요한 SQL 적용 여부를 확인하세요.'); }
  }
  useEffect(() => { void load(); }, [api, organizationId]);

  async function addSupplier() {
    if (!supplierName.trim()) return;
    setBusy(true);
    try {
      const saved = await catalogApi.createSupplier(api, organizationId, { name: supplierName.trim(), contact_name: supplierContact.trim(), phone: supplierPhone.trim(), email: supplierEmail.trim(), note: supplierNote.trim(), is_active: true });
      setSuppliers((old) => [...old, saved]); setSupplierId(saved.id);
      setSupplierName(''); setSupplierContact(''); setSupplierPhone(''); setSupplierEmail(''); setSupplierNote('');
      notify.success('공급처를 등록했습니다.');
    } catch { setError('공급처를 등록하지 못했습니다. 이름 중복과 권한을 확인하세요.'); }
    finally { setBusy(false); }
  }

  async function createOrder() {
    const normalized = lines.map((line) => ({ ...line, quantity_ordered: Number(line.quantity_ordered) }));
    if (!supplierId || normalized.some((line) => !line.product_id || !Number.isInteger(line.quantity_ordered) || line.quantity_ordered < 1 || !/^\d{1,12}$/.test(line.unit_cost))) {
      setError('공급처와 모든 품목의 상품·수량·매입 단가를 확인하세요.'); return;
    }
    if (busy || pending || readOnly) return;
    await creation.submit({ supplier_id: supplierId, operation_id: crypto.randomUUID(), note: '', lines: normalized });
  }

  async function change(row: Order, status: 'ordered' | 'canceled') {
    setBusy(true);
    try { await catalogApi.updatePurchaseOrder(api, organizationId, row.id, { status, expected_version: row.version }); await load(); }
    catch { setError('발주 상태가 변경되었거나 저장에 실패했습니다. 새로고침해 주세요.'); }
    finally { setBusy(false); }
  }

  function receive(row: Order, line: Order['lines'][number]) {
    if (busy || pending || readOnly) return;
    setReceiving({ row, line }); setQuantity(String(line.quantity_ordered - line.quantity_received)); setExpiresOn(''); setLotCode('');
  }
  async function confirmReceipt() {
    if (!receiving || busy || pending || readOnly) return;
    const qty = Number(quantity), remaining = receiving.line.quantity_ordered - receiving.line.quantity_received;
    if (!Number.isInteger(qty) || qty < 1 || qty > remaining) { setError(`입고 수량은 1~${remaining} 사이의 정수로 입력하세요.`); return; }
    await receipt.submit({ order_id: receiving.row.id, line_id: receiving.line.id, quantity: qty, operation_id: crypto.randomUUID(), expires_on: expiresOn || null, lot_code: lotCode.trim() });
  }

  const supplierNameOf = (id: string) => suppliers.find((x) => x.id === id)?.name ?? '공급처 정보 없음';
  const productOptions = [{ value: '', label: '상품 선택' }, ...products.filter((x) => x.kind === 'product' && x.is_active).map((x) => ({ value: x.id, label: x.name }))];
  return <Modal title="공급처 · 발주 · 입고" size="lg" onClose={() => void close()}><section className="purchase-dialog">
    {(receipt.message || creation.message) && <p role="alert" className="form-error">{receipt.message || creation.message}</p>}
    {(receipt.invalid || creation.invalid) && <p role="alert">복구 정보 형식이 올바르지 않습니다. 새 요청을 보내지 말고 관리자에게 확인하세요.</p>}
    {receipt.pending && <p>미확인 입고 {receipt.pending.quantity}개 {receipt.pending.expires_on ? `· 유통기한 ${receipt.pending.expires_on}` : ''} <button type="button" disabled={busy || readOnly} onClick={receipt.retry}>입고 결과 다시 확인</button></p>}
    {creation.pending && <p>미확인 발주 <button type="button" disabled={busy || readOnly} onClick={creation.retry}>발주 결과 다시 확인</button></p>}
    {receiving && !pending && <fieldset disabled={busy}><legend>입고 수량 확인</legend><p>{products.find(p => p.id === receiving.line.product_id)?.name ?? '상품'} · 잔여 {receiving.line.quantity_ordered - receiving.line.quantity_received}{receiving.line.purchase_unit_name_snapshot} (재고 {(receiving.line.quantity_ordered - receiving.line.quantity_received) * receiving.line.units_per_purchase_unit}{products.find(p => p.id === receiving.line.product_id)?.unit_name ?? '개'})</p><label>입고 수량 ({receiving.line.purchase_unit_name_snapshot})<input aria-label="입고 수량" type="number" min={1} max={receiving.line.quantity_ordered - receiving.line.quantity_received} value={quantity} onChange={e => setQuantity(e.currentTarget.value)} /></label><label>로트 번호<input aria-label="로트 번호" maxLength={120} value={lotCode} onChange={e => setLotCode(e.currentTarget.value)} /></label><label>유통기한<input aria-label="유통기한" type="date" value={expiresOn} onChange={e => setExpiresOn(e.currentTarget.value)} /></label><button type="button" onClick={() => void confirmReceipt()}>입고 반영</button><button type="button" onClick={() => setReceiving(null)}>입고 취소</button></fieldset>}
    {error && <p role="alert" className="form-error">{error}<button type="button" onClick={() => void load()}>새로고침</button></p>}
    {!readOnly && <>
      <fieldset disabled={busy || pending}><legend>공급처 등록</legend>
        <label>공급처 이름<input aria-label="공급처 이름" maxLength={160} value={supplierName} onChange={(e) => setSupplierName(e.currentTarget.value)} /></label>
        <label>담당자<input aria-label="공급처 담당자" maxLength={120} value={supplierContact} onChange={(e) => setSupplierContact(e.currentTarget.value)} /></label>
        <label>연락처<input aria-label="공급처 연락처" maxLength={40} value={supplierPhone} onChange={(e) => setSupplierPhone(e.currentTarget.value)} /></label>
        <label>이메일<input aria-label="공급처 이메일" type="email" maxLength={254} value={supplierEmail} onChange={(e) => setSupplierEmail(e.currentTarget.value)} /></label>
        <label>메모<input aria-label="공급처 메모" maxLength={1000} value={supplierNote} onChange={(e) => setSupplierNote(e.currentTarget.value)} /></label>
        <button type="button" onClick={() => void addSupplier()}>공급처 저장</button>
      </fieldset>
      <fieldset disabled={busy || pending}><legend>발주 초안</legend>
        <label>공급처<Select aria-label="발주 공급처" value={supplierId} onChange={setSupplierId} options={[{ value: '', label: '공급처 선택' }, ...suppliers.map((x) => ({ value: x.id, label: x.name }))]} /></label>
        {lines.map((line, index) => <div className="purchase-line" key={index}>
          <label>상품<Select aria-label={`발주 상품 ${index + 1}`} value={line.product_id} onChange={(value) => setLines((old) => old.map((item, i) => i === index ? { ...item, product_id: value } : item))} options={productOptions} /></label>
          <label>수량 ({products.find(p => p.id === line.product_id)?.purchase_unit_name ?? '매입 단위'})<input aria-label={`발주 수량 ${index + 1}`} type="number" min={1} value={line.quantity_ordered} onChange={(e) => setLines((old) => old.map((item, i) => i === index ? { ...item, quantity_ordered: e.currentTarget.value } : item))} /></label>
          <label>매입 단가 ({products.find(p => p.id === line.product_id)?.purchase_unit_name ?? '매입 단위'})<input aria-label={`매입 단가 ${index + 1}`} inputMode="numeric" value={line.unit_cost} onChange={(e) => setLines((old) => old.map((item, i) => i === index ? { ...item, unit_cost: e.currentTarget.value } : item))} /></label>
          {products.find(p => p.id === line.product_id) && <small className="muted">재고 환산: {line.quantity_ordered || 0} {products.find(p => p.id === line.product_id)!.purchase_unit_name} = {Number(line.quantity_ordered || 0) * products.find(p => p.id === line.product_id)!.units_per_purchase_unit} {products.find(p => p.id === line.product_id)!.unit_name}</small>}
          <label>품목 메모<input aria-label={`발주 메모 ${index + 1}`} maxLength={500} value={line.note} onChange={(e) => setLines((old) => old.map((item, i) => i === index ? { ...item, note: e.currentTarget.value } : item))} /></label>
          {lines.length > 1 && <button type="button" onClick={() => setLines((old) => old.filter((_, i) => i !== index))}>품목 삭제</button>}
        </div>)}
        <button type="button" onClick={() => setLines((old) => [...old, emptyLine()])}>품목 추가</button>
        <button type="button" onClick={() => void createOrder()}>발주 초안 만들기</button>
      </fieldset>
    </>}
    <div className="purchase-list">{orders.map((row) => <article key={row.id}><header><strong>{supplierNameOf(row.supplier_id)}</strong><span>{row.status === 'draft' ? '초안' : row.status === 'ordered' ? '발주됨' : row.status === 'received' ? '입고 완료' : '취소'}</span></header>{row.lines.map((line) => <div className="purchase-line" key={line.id}><span>{products.find((p) => p.id === line.product_id)?.name ?? '상품'} · {line.quantity_received}/{line.quantity_ordered} {line.purchase_unit_name_snapshot} 입고 · 재고 환산 {(line.quantity_received * line.units_per_purchase_unit).toLocaleString()}개 · {Number(line.unit_cost).toLocaleString()}원/{line.purchase_unit_name_snapshot}</span>{!readOnly && row.status === 'ordered' && line.quantity_received < line.quantity_ordered && <button type="button" disabled={busy || pending} onClick={() => void receive(row, line)}>입고</button>}</div>)}{!readOnly && row.status === 'draft' && <button type="button" disabled={busy || pending} onClick={() => void change(row, 'ordered')}>발주 확정</button>}{!readOnly && (row.status === 'draft' || row.status === 'ordered') && <button type="button" disabled={busy || pending} onClick={() => void change(row, 'canceled')}>취소</button>}</article>)}{!orders.length && <p className="empty-state">발주 내역이 없습니다.</p>}</div>
  </section></Modal>;
}
