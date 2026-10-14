import { usePrivacy } from '../../lib/privacy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Select, confirm } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import type { Customer } from '../../api/schemas';
import { salesApi } from './api';
import { errorMessage, formatWon, isDefinitive, kst, moneyText, newOperationId, visitStatusLabel, wholeAmount } from './format';
import { ExportButton } from '../../lib/io/ExportButton';
import { visitExportColumns } from '../../lib/io/domainColumns';
import { PaymentDialog } from './PaymentDialog';
import { PaymentHistoryPanel } from './PaymentHistoryPanel';
import { WalletUseDialog } from '../catalog/WalletDialogs';
import type { CartBundle, CartLine, CatalogItem, SaleDraft, SalePayment, Visit } from './types';
import './sales.css';

type DiscountForm = { kind: 'none' | 'amount' | 'percent'; value: string; reason: string; confirmed: boolean };
type LineForm = { quantity: string; price: string; staff: string; reason: string };
type Pending = { kind: string; run: () => Promise<CartBundle> };

const cartStatusLabel: Record<string, string> = { draft: '작성 중', ready: '검토 완료', collecting: '수납 중', paid: '수납 완료', void: '취소' };
const discountFromCart = (bundle: CartBundle | null): DiscountForm => bundle
  ? { kind: bundle.cart.discount_kind, value: bundle.cart.discount_kind === 'none' ? '' : bundle.cart.discount_value, reason: bundle.cart.discount_reason, confirmed: false }
  : { kind: 'amount', value: '', reason: '', confirmed: false };
const lineForm = (line: CartLine | undefined): LineForm => line
  ? { quantity: String(line.quantity), price: line.unit_price, staff: line.staff_name_snapshot, reason: line.removal_reason }
  : { quantity: '1', price: '', staff: '', reason: '' };
const sameForm = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
const discountLabel = (cart: CartBundle['cart']) => {
  const detail = cart.discount_kind === 'amount' ? `정액 ${formatWon(cart.discount_value)}` : cart.discount_kind === 'percent' ? `비율 ${cart.discount_value}%` : '수동 할인 없음';
  return `할인 ${formatWon(cart.discount_total)} · ${detail}${cart.discount_reason ? ` · ${cart.discount_reason}` : ''}`;
};

type OpenRequest = { customerId: string; visitId: string; nonce: number };
type SalesView = 'cart' | 'history';

/** 매출 화면: 장바구니와 매출 내역(수납·환불 검색) 두 탭. 장바구니는 탭을 옮겨도 입력 상태를 유지하려고 숨기기만 한다. */
export function SalesPage({ api, organizationId, readOnly, organizationName = '' }: { api: ApiClient; organizationId: string; readOnly: boolean; organizationName?: string }) {
  const [view, setView] = useState<SalesView>('cart');
  const [historyOpened, setHistoryOpened] = useState(false);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  const choose = (next: SalesView) => { if (next === 'history') setHistoryOpened(true); setView(next); };
  const openVisit = (row: SalePayment) => { setOpenRequest({ customerId: row.customer_id, visitId: row.visit_id, nonce: (openRequest?.nonce ?? 0) + 1 }); setView('cart'); };
  return <div className="sales-shell">
    <div className="sales-tabs" role="tablist" aria-label="매출 화면">
      <button type="button" role="tab" aria-selected={view === 'cart'} className={view === 'cart' ? 'is-active' : ''} onClick={() => choose('cart')}>장바구니</button>
      <button type="button" role="tab" aria-selected={view === 'history'} className={view === 'history' ? 'is-active' : ''} onClick={() => choose('history')}>매출 내역</button>
    </div>
    <div className={`sales-shell__pane${view === 'cart' ? '' : ' is-hidden'}`} role="tabpanel" aria-label="장바구니">
      <CartView api={api} organizationId={organizationId} readOnly={readOnly} openRequest={openRequest} organizationName={organizationName} />
    </div>
    {historyOpened && <div className={`sales-shell__pane${view === 'history' ? '' : ' is-hidden'}`} role="tabpanel" aria-label="매출 내역">
      <section className="sales-page">
        <div className="page-toolbar"><div><p className="eyebrow">SALES</p><h1>매출 내역</h1><p className="muted">수납·환불·반품 내역을 일자·고객·수단·유형·금액으로 검색합니다. 읽기 전용입니다.</p></div></div>
        <PaymentHistoryPanel api={api} organizationId={organizationId} onOpenVisit={openVisit} />
      </section>
    </div>}
  </div>;
}

function CartView({ api, organizationId, readOnly, openRequest, organizationName }: { api: ApiClient; organizationId: string; readOnly: boolean; openRequest: OpenRequest | null; organizationName: string }) {
  const privacy = usePrivacy();
  const canManage = !readOnly;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [drafts, setDrafts] = useState<SaleDraft[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [warning, setWarning] = useState('');
  const [query, setQuery] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [visitId, setVisitId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<CartBundle | null>(null);
  const [cartLoading, setCartLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState<'info' | 'error'>('info');
  const [lineId, setLineId] = useState<string | null>(null);
  const [editor, setEditor] = useState<LineForm>(lineForm(undefined));
  const [discount, setDiscount] = useState<DiscountForm>(discountFromCart(null));
  const [payOpen, setPayOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const request = useRef(0);
  const pendingOperation = useRef<{ kind: string; id: string } | null>(null);

  const selectedLine = bundle?.lines.find((line) => line.id === lineId);
  const dirty = (selectedLine !== undefined && !sameForm(editor, lineForm(selectedLine))) || (bundle !== null && !sameForm(discount, discountFromCart(bundle)));
  const say = (text: string, tone: 'info' | 'error' = 'info') => { setStatus(text); setStatusTone(tone); };

  async function allowChange(): Promise<boolean> {
    if (busy || pending) { say('현재 요청의 결과를 확인한 뒤 이동하세요.', 'error'); return false; }
    if (!dirty) return true;
    return confirm({ title: '저장하지 않은 입력', message: '수정 중인 내용을 버리고 이동할까요?', confirmLabel: '버리기', tone: 'danger' });
  }

  const showBundle = useCallback((next: CartBundle | null) => {
    setBundle(next);
    setLineId(null);
    setEditor(lineForm(undefined));
    setDiscount(discountFromCart(next));
    if (next) setVisits((old) => old.some((visit) => visit.id === next.visit.id) ? old.map((visit) => visit.id === next.visit.id ? next.visit : visit) : [next.visit, ...old]);
  }, []);

  const loadCart = useCallback(async (id: string) => {
    const ticket = ++request.current;
    setCartLoading(true);
    say('선택한 방문의 장바구니를 불러오는 중…');
    try {
      const next = await salesApi.cart(api, organizationId, id);
      if (ticket !== request.current) return;
      showBundle(next);
      say('방문 내역을 불러왔습니다. 실제 수납은 ‘수납 기록 · 내역’에서 확인하세요.');
    } catch (error) {
      if (ticket !== request.current) return;
      showBundle(null);
      say(errorMessage(error, '장바구니 조회'), 'error');
    } finally { if (ticket === request.current) setCartLoading(false); }
  }, [api, organizationId, showBundle]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    const [c, v, d, p] = await Promise.allSettled([api.listCustomers(organizationId), salesApi.visits(api, organizationId), salesApi.drafts(api, organizationId), salesApi.catalog(api, organizationId)]);
    if (c.status === 'rejected') { setLoadError('고객 목록을 불러오지 못했습니다.'); setLoading(false); return; }
    setCustomers(c.value);
    if (v.status === 'fulfilled') setVisits(v.value);
    if (d.status === 'fulfilled') setDrafts(d.value);
    if (p.status === 'fulfilled') setCatalog(p.value);
    const failures = [v, d, p].filter((item) => item.status === 'rejected').length;
    setWarning(failures ? `일부 자료 ${failures}개를 불러오지 못했습니다. 성공한 자료는 유지했습니다.` : '');
    setLoading(false);
  }, [api, organizationId]);
  useEffect(() => { void load(); }, [load]);

  const customerVisits = useMemo(() => visits.filter((visit) => visit.customer_id === customerId && visit.status !== 'canceled'), [visits, customerId]);
  const visitRows = useMemo(() => {
    const names = new Map(customers.map((customer) => [customer.id, customer.name]));
    return [...visits]
      .sort((a, b) => b.opened_at.localeCompare(a.opened_at))
      .map((visit) => ({ visit, customerName: names.get(visit.customer_id) ?? '' }));
  }, [visits, customers]);
  const filteredCustomers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return customers.filter((customer) => customer.status !== 'archived' && `${customer.name} ${customer.phone ?? ''}`.toLowerCase().includes(needle));
  }, [customers, query]);

  async function selectCustomer(id: string) {
    if (id === customerId || !await allowChange()) return;
    setCustomerId(id);
    const first = visits.find((visit) => visit.customer_id === id && visit.status !== 'canceled');
    setVisitId(first?.id ?? null);
    showBundle(null);
    if (first) void loadCart(first.id); else say('열린 방문이 없습니다. 새 방문을 시작하세요.');
  }
  async function selectVisit(id: string) {
    if (id === visitId || !await allowChange()) return;
    setVisitId(id);
    void loadCart(id);
  }
  async function reload() {
    if (!await allowChange()) return;
    await load();
    if (visitId) void loadCart(visitId);
  }

  /** 변경 요청 공통 처리: 같은 작업 ID로 재시도할 수 있도록 pending을 보관한다. */
  async function mutate(kind: string, execute: (operationId: string) => Promise<CartBundle>, success: string, retrying = false) {
    if (busy) return;
    if (!retrying && pending) return;
    const operation = retrying && pendingOperation.current ? pendingOperation.current : { kind, id: newOperationId() };
    pendingOperation.current = operation;
    const run = () => execute(operation.id);
    setPending({ kind, run });
    setBusy(true);
    try {
      const next = await run();
      pendingOperation.current = null;
      setPending(null);
      showBundle(next);
      if (kind === 'create') { setVisitId(next.visit.id); setCustomerId(next.visit.customer_id); }
      say(success);
    } catch (error) {
      if (isDefinitive(error)) { pendingOperation.current = null; setPending(null); }
      say(errorMessage(error), 'error');
    } finally { setBusy(false); }
  }
  const retryPending = () => { if (pending && !busy) void mutate(pending.kind, () => pending.run(), '장바구니를 저장했습니다. 아직 수납이나 매출로 확정되지 않았습니다.', true); };

  const cart = bundle?.cart;
  const editable = canManage && !busy && !pending && cart !== undefined && (cart.status === 'draft' || cart.status === 'ready');
  const activeLines = bundle?.lines.filter((line) => line.status === 'active') ?? [];
  const usedSources = new Set(activeLines.map((line) => line.source_id));
  const availableDrafts = drafts.filter((draft) => draft.customer_id === customerId && !usedSources.has(draft.id));
  const availableCatalog = catalog.filter((item) => item.is_active !== false && !usedSources.has(item.id));
  const saved = '장바구니를 저장했습니다. 아직 수납이나 매출로 확정되지 않았습니다.';

  const startVisit = async () => {
    if (!canManage || !customerId || busy || pending || !await allowChange()) return;
    void mutate('create', (id) => salesApi.createVisit(api, organizationId, customerId, id), saved);
  };
  const addDraft = async (draft: SaleDraft) => {
    if (!editable || !bundle || !await allowChange()) return;
    void mutate('add', (id) => salesApi.addDraft(api, organizationId, bundle.visit.id, draft.id, bundle.cart.version, id), saved);
  };
  const addCatalog = async (item: CatalogItem) => {
    if (!editable || !bundle || !await allowChange()) return;
    void mutate('add', (id) => salesApi.addCatalogProduct(api, organizationId, bundle.visit.id, item.id, bundle.cart.version, id), saved);
  };
  const saveLine = () => {
    if (!editable || !bundle || !selectedLine) return;
    const quantity = Number(editor.quantity);
    const price = editor.price.trim();
    const staff = editor.staff.trim();
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999 || !moneyText.test(price) || staff.length > 200) { say('수량(1~999)과 단가(소수 둘째 자리까지)를 확인하세요.', 'error'); return; }
    void mutate('update', (id) => salesApi.updateLine(api, organizationId, bundle.visit.id, selectedLine.id, bundle.cart.version, id, { quantity, unit_price: price, staff_id: selectedLine.staff_id, staff_name: staff }), saved);
  };
  const removeLine = () => {
    if (!editable || !bundle || !selectedLine) return;
    const reason = editor.reason.trim();
    if (!reason) { say('항목을 제거하려면 사유를 입력하세요.', 'error'); return; }
    void mutate('remove', (id) => salesApi.removeLine(api, organizationId, bundle.visit.id, selectedLine.id, bundle.cart.version, id, reason), saved);
  };
  const restoreLine = () => {
    if (!editable || !bundle || !selectedLine) return;
    void mutate('restore', (id) => salesApi.restoreLine(api, organizationId, bundle.visit.id, selectedLine.id, bundle.cart.version, id), saved);
  };
  const applyDiscount = () => {
    if (!editable || !bundle) return;
    const value = discount.kind === 'none' ? '0' : discount.value.trim();
    const reason = discount.reason.trim();
    const ok = reason && reason.length <= 1000 && wholeAmount.test(value) && (discount.kind !== 'amount' || Number(value) >= 1) && (discount.kind !== 'percent' || (Number(value) >= 1 && Number(value) <= 99)) && discount.confirmed;
    if (!ok) { say('할인 종류·금액·사유와 확인 항목을 점검하세요.', 'error'); return; }
    void mutate('discount', (id) => salesApi.discount(api, organizationId, bundle.visit.id, { kind: discount.kind, value, reason, expected_version: bundle.cart.version, operation_id: id }), '할인 규칙을 저장했습니다. 결제 전까지 장바구니를 다시 검토할 수 있습니다.');
  };
  const review = async () => {
    if (!editable || !bundle || !await allowChange()) return;
    void mutate('review', (id) => salesApi.review(api, organizationId, bundle.visit.id, bundle.cart.version, id, true), saved);
  };
  const cancelVisit = async () => {
    if (!editable || !bundle || !await allowChange()) return;
    if (!await confirm({ title: '빈 방문 취소', message: '이 방문을 취소할까요? 담긴 항목이 없는 방문만 취소할 수 있습니다.', confirmLabel: '방문 취소', tone: 'danger' })) return;
    void mutate('cancel', (id) => salesApi.cancelVisit(api, organizationId, bundle.visit.id, bundle.visit.version, id), '방문을 취소했습니다.');
  };
  const openPayments = async () => {
    if (!bundle || !await allowChange()) return;
    setPayOpen(true);
  };

  const handledRequest = useRef(0);
  useEffect(() => {
    if (!openRequest || loading || handledRequest.current === openRequest.nonce) return;
    handledRequest.current = openRequest.nonce;
    void openFromHistory(openRequest);
    // 요청 번호가 바뀔 때 한 번만 처리한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest, loading]);
  async function openFromHistory(target: OpenRequest) {
    if (target.visitId === visitId && bundle) return;
    if (!await allowChange()) return;
    setCustomerId(target.customerId);
    setVisitId(target.visitId);
    showBundle(null);
    void loadCart(target.visitId);
  }

  if (loading) return <section className="sales-page"><p role="status" className="muted">고객과 열린 방문, 시술 초안을 불러오는 중…</p></section>;
  if (loadError) return <section className="sales-page"><div role="alert" className="form-error">{loadError} <button type="button" onClick={() => void load()}>다시 시도</button></div></section>;

  return <section className="sales-page">
    <div className="page-toolbar">
      <div><p className="eyebrow">SALES</p><h1>방문 결제 장바구니</h1><p className="muted">시술 청구 초안을 방문별로 검토합니다. 검토 완료 후 실제 받은 금액을 수납 기록에 남기세요.</p></div>
      <div className="sales-toolbar-actions">
        <ExportButton title="방문 내역" columns={visitExportColumns} rows={visitRows} />
        <button type="button" disabled={busy || pending !== null} onClick={() => void reload()}>자료 새로고침</button>
      </div>
    </div>
    {readOnly && <p className="permission-banner">조회 전용입니다. 장바구니 변경과 수납 기록은 관리자만 할 수 있습니다.</p>}
    {warning && <p role="alert" className="form-error">{warning}</p>}
    <div className="sales-layout">
      <aside className="editor-panel sales-col">
        <h2>고객 · 방문</h2>
        <input aria-label="고객 검색" placeholder="이름, 연락처 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
        <ul className="sales-list" aria-label="고객">
          {filteredCustomers.map((customer) => <li key={customer.id}><button type="button" aria-pressed={customer.id === customerId} className={customer.id === customerId ? 'is-active' : ''} disabled={busy || pending !== null} onClick={() => void selectCustomer(customer.id)}>{customer.name}<small>{privacy.phone(customer.phone) || '연락처 없음'}</small></button></li>)}
        </ul>
        {filteredCustomers.length === 0 && <p className="empty-state">{customers.length ? '검색 결과가 없습니다.' : '등록된 고객이 없습니다.'}</p>}
        <h3>방문 내역 · 수납 확인</h3>
        <ul className="sales-list" aria-label="방문 내역">
          {customerVisits.map((visit) => <li key={visit.id}><button type="button" aria-pressed={visit.id === visitId} className={visit.id === visitId ? 'is-active' : ''} disabled={busy || pending !== null} onClick={() => void selectVisit(visit.id)}>{kst(visit.opened_at)} · {visitStatusLabel[visit.status] ?? '상태 확인 필요'}</button></li>)}
        </ul>
        {customerId && customerVisits.length === 0 && <p className="muted">열린 방문이 없습니다. 새 방문을 시작하세요.</p>}
        {canManage && <button type="button" className="primary-button" disabled={!customerId || busy || pending !== null} onClick={() => void startVisit()}>새 방문 시작</button>}
      </aside>

      <div className="editor-panel sales-col sales-col--wide">
        <h2>청구 항목</h2>
        {cartLoading && <p role="status" className="muted">장바구니를 불러오는 중…</p>}
        {!bundle && !cartLoading && <p className="empty-state">고객과 방문을 선택하세요.</p>}
        {bundle && <>
          <p className="muted">장바구니 상태: {cartStatusLabel[bundle.cart.status] ?? bundle.cart.status}{bundle.cart.status === 'draft' || bundle.cart.status === 'ready' ? '' : ' · 청구 항목은 수정할 수 없습니다.'}</p>
          <div className="data-surface"><table><caption>현재 장바구니</caption><thead><tr><th>항목</th><th>수량</th><th>단가</th><th>담당자</th><th>상태</th></tr></thead>
            <tbody>{bundle.lines.map((line) => <tr key={line.id} className={line.id === lineId ? 'is-selected' : ''} aria-selected={line.id === lineId}>
              <td><button type="button" className="sales-link" disabled={busy || pending !== null} onClick={async () => { if (line.id === lineId || !await allowChange()) return; setLineId(line.id); setEditor(lineForm(line)); }}>{line.description_snapshot}</button></td>
              <td>{line.quantity}</td><td>{formatWon(line.unit_price)}</td><td>{line.staff_name_snapshot}</td><td>{line.status === 'removed' ? '제거됨' : '활성'}</td></tr>)}</tbody></table>
            {bundle.lines.length === 0 && <p className="empty-state">담긴 항목이 없습니다.</p>}
          </div>
          {selectedLine && <div className="sales-form" aria-label="항목 편집">
            <div className="sales-form__row">
              <label>수량<input inputMode="numeric" disabled={!editable} value={editor.quantity} onChange={(e) => setEditor({ ...editor, quantity: e.target.value })} /></label>
              <label>단가<input inputMode="decimal" disabled={!editable} value={editor.price} onChange={(e) => setEditor({ ...editor, price: e.target.value })} /></label>
              <label>담당자<input maxLength={200} disabled={!editable} value={editor.staff} onChange={(e) => setEditor({ ...editor, staff: e.target.value })} /></label>
              <label>제거 사유<input maxLength={1000} disabled={!editable} value={editor.reason} onChange={(e) => setEditor({ ...editor, reason: e.target.value })} /></label>
            </div>
            {canManage && <div className="sales-actions">
              <button type="button" disabled={!editable || selectedLine.status !== 'active'} onClick={saveLine}>항목 수정</button>
              <button type="button" className="danger-button" disabled={!editable || selectedLine.status !== 'active'} onClick={removeLine}>항목 제거</button>
              <button type="button" disabled={!editable || selectedLine.status !== 'removed'} onClick={restoreLine}>제거 취소</button>
            </div>}
          </div>}
          {canManage && <>
            <h3>담기 전 시술 초안</h3>
            <ul className="sales-list" aria-label="시술 초안">
              {availableDrafts.map((draft) => <li key={draft.id}><span>{draft.description}<small>{formatWon(draft.amount)}</small></span><button type="button" aria-label={`시술 초안 담기 ${draft.description}`} disabled={!editable} onClick={() => void addDraft(draft)}>담기</button></li>)}
            </ul>
            {availableDrafts.length === 0 && <p className="muted">담을 수 있는 시술 초안이 없습니다.</p>}
            <h3>판매 상품 · 회원권</h3>
            <ul className="sales-list" aria-label="판매 상품">
              {availableCatalog.map((item) => <li key={item.id}><span>[{item.kind === 'product' ? '상품' : '회원권'}] {item.name}<small>{formatWon(item.sale_price)}{item.kind === 'product' && item.stock_quantity !== undefined ? ` · 재고 ${item.stock_quantity}${item.unit_name ?? ''}` : ''}</small></span><button type="button" aria-label={`상품 담기 ${item.name}`} disabled={!editable} onClick={() => void addCatalog(item)}>담기</button></li>)}
            </ul>
          </>}
        </>}
      </div>

      <aside className="editor-panel sales-col">
        <h2>금액 검토</h2>
        {cart && <>
          <p data-testid="subtotal">소계 {formatWon(cart.subtotal)}</p>
          <p data-testid="discount-summary" title={bundle?.discount_history.length ? '할인 변경 이력이 있습니다.' : undefined}>{discountLabel(cart)}</p>
          <p className="sales-total" data-testid="total">청구 예정 {formatWon(cart.total_amount)}</p>
          {bundle && bundle.discount_history.length > 0 && <details><summary>할인 변경 이력 {bundle.discount_history.length}건</summary><ul>{bundle.discount_history.map((event, index) => <li key={index}>{kst(String(event.created_at ?? ''))} · {event.discount_kind === 'amount' ? `정액 ${formatWon(event.discount_value)}` : event.discount_kind === 'percent' ? `비율 ${String(event.discount_value)}%` : '할인 해제'} · {formatWon(event.discount_total)} · {String(event.reason ?? '')}</li>)}</ul></details>}
          {canManage && <div className="sales-form" aria-label="수동 할인">
            <label>할인 종류<Select aria-label="할인 종류" disabled={!editable} value={discount.kind} onChange={(kind) => setDiscount({ ...discount, kind })} options={[{ value: 'amount', label: '금액 할인' }, { value: 'percent', label: '비율 할인' }, { value: 'none', label: '할인 해제' }]} /></label>
            <label>할인 값<input inputMode="numeric" maxLength={12} placeholder="할인 금액(원) 또는 비율(%)" disabled={!editable || discount.kind === 'none'} value={discount.kind === 'none' ? '' : discount.value} onChange={(e) => setDiscount({ ...discount, value: e.target.value })} /></label>
            <label>할인 사유<input maxLength={1000} disabled={!editable} value={discount.reason} onChange={(e) => setDiscount({ ...discount, reason: e.target.value })} /></label>
            <label className="sales-check"><input type="checkbox" disabled={!editable} checked={discount.confirmed} onChange={(e) => setDiscount({ ...discount, confirmed: e.target.checked })} />할인 내용과 권한을 확인했습니다.</label>
            <button type="button" disabled={!editable} onClick={applyDiscount}>할인 적용</button>
          </div>}
          <p className="muted">검토 완료는 결제 완료가 아닙니다.</p>
        </>}
        <div className="sales-actions sales-actions--stack">
          {canManage && <button type="button" className="primary-button" disabled={!editable || activeLines.length === 0} onClick={() => void review()}>검토 완료</button>}
          {canManage && <button type="button" disabled={!editable || !customerId || activeLines.length === 0} onClick={() => setWalletOpen(true)}>회원권 사용</button>}
          <button type="button" disabled={busy || pending !== null || !cart || !['ready', 'collecting', 'paid', 'void'].includes(cart.status)} onClick={() => void openPayments()}>수납 기록 · 내역</button>
          {canManage && <button type="button" className="danger-button" disabled={!editable || activeLines.length > 0} onClick={() => void cancelVisit()}>빈 방문 취소</button>}
          {pending && <button type="button" disabled={busy} onClick={retryPending}>같은 요청 재시도</button>}
        </div>
      </aside>
    </div>
    {status && <p role={statusTone === 'error' ? 'alert' : 'status'} className={statusTone === 'error' ? 'form-error' : 'muted'}>{status}</p>}
    {payOpen && bundle && <PaymentDialog api={api} organizationId={organizationId} visitId={bundle.visit.id} canManage={canManage} organizationName={organizationName} customerName={customers.find((item) => item.id === bundle.visit.customer_id)?.name ?? ''} onClose={() => { setPayOpen(false); void loadCart(bundle.visit.id); }} />}
    {walletOpen && bundle && customerId && <WalletUseDialog api={api} organizationId={organizationId} customerId={customerId} bundle={bundle} readOnly={!canManage} onClose={() => setWalletOpen(false)} onUsed={() => void loadCart(bundle.visit.id)} />}
  </section>;
}
