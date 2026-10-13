import { useCallback, useEffect, useMemo, useState } from 'react';
import { DataGrid, ErrorState, LoadingState, Modal, Select, confirm, notify, type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { isDefiniteRejection, useOperationTracker } from '../appointment-resources/operationIds';
import { catalogApi, type ProductInput, type StockChangeKind } from './api';
import { movementLabel, won, type CatalogProduct, type StockMovement } from './schemas';
import './catalog.css';

type Form = { kind: 'product' | 'membership'; sku: string; name: string; unit_name: string; sale_price: string; benefit_money: string; benefit_count: string; valid_days: string; is_active: boolean };
type Stock = { kind: StockChangeKind; quantity: string; reason: string };
const emptyForm = (): Form => ({ kind: 'product', sku: '', name: '', unit_name: '개', sale_price: '', benefit_money: '0', benefit_count: '0', valid_days: '', is_active: true });
const emptyStock = (): Stock => ({ kind: 'supplier_return', quantity: '1', reason: '' });
const fromProduct = (row: CatalogProduct): Form => ({
  kind: row.kind, sku: row.sku, name: row.name, unit_name: row.unit_name, sale_price: row.sale_price, benefit_money: row.benefit_money,
  benefit_count: String(row.benefit_count), valid_days: row.valid_days === null ? '' : String(row.valid_days), is_active: row.is_active,
});
const PRICE = /^[1-9][0-9]{0,11}$/;
const BENEFIT = /^(0|[1-9][0-9]{0,11})$/;

/** 입력을 서버 요청으로 바꾼다. 서버(Python과 동일 규칙)가 다시 검증하지만, 같은 문구로 먼저 안내한다. */
export function toProductInput(form: Form): ProductInput | string {
  const sku = form.sku.trim(), name = form.name.trim(), unit = form.unit_name.trim(), price = form.sale_price.trim(), benefit = form.benefit_money.trim();
  if (!sku || !name || !unit || !PRICE.test(price)) return 'SKU, 이름, 단위와 1원 이상의 판매가를 확인하세요.';
  const count = Number(form.benefit_count || '0');
  if (form.kind === 'membership') {
    if (!BENEFIT.test(benefit) || !Number.isInteger(count) || count < 0 || count > 999_999 || (Number(benefit) === 0 && count === 0)) return '회원권은 제공 금액이나 제공 횟수가 필요합니다.';
    const days = form.valid_days.trim() === '' ? 0 : Number(form.valid_days);
    if (!Number.isInteger(days) || days < 0 || days > 3650) return '유효 일수는 1~3650일이며 비우면 기간 제한이 없습니다.';
    return { sku, name, kind: 'membership', unit_name: unit, sale_price: price, benefit_money: benefit, benefit_count: count, valid_days: days || null, is_active: form.is_active };
  }
  return { sku, name, kind: 'product', unit_name: unit, sale_price: price, benefit_money: '0', benefit_count: 0, valid_days: null, is_active: form.is_active };
}

export interface InventoryPageProps { api: ApiClient; organizationId: string; readOnly: boolean }

/** 상품·회원권(판매 조건)과 재고(입고·반품·폐기·실사, 변동 이력) 관리. 쓰기는 관리자(owner/admin)만. */
export function InventoryPage({ api, organizationId, readOnly }: InventoryPageProps) {
  const [rows, setRows] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'product' | 'membership'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [stock, setStock] = useState<Stock>(emptyStock);
  const [baseline, setBaseline] = useState(() => JSON.stringify([emptyForm(), emptyStock()]));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<{ product: CatalogProduct; movements: StockMovement[] } | null>(null);
  const saveOp = useOperationTracker();
  const receiptOp = useOperationTracker();
  const adjustOp = useOperationTracker();

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const dirty = JSON.stringify([form, stock]) !== baseline;
  const editable = !readOnly && !busy;

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try { setRows(await catalogApi.listProducts(api, organizationId)); }
    catch (error) { setLoadError((error as { status?: number }).status === 403 ? '상품·재고 권한이 없습니다.' : '상품과 회원권을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [api, organizationId]);
  useEffect(() => { void load(); }, [load]);

  const fill = (next: Form, nextStock: Stock) => { setForm(next); setStock(nextStock); setBaseline(JSON.stringify([next, nextStock])); };
  /** 변경이 없으면 바로, 있으면 확인을 거친 뒤 실행한다(변경 없는 이동은 동기로 처리된다). */
  const guarded = (action: () => void) => {
    if (!dirty) { action(); return; }
    void confirm({ title: '작성 중인 상품·재고 변경', message: '저장하지 않은 내용을 버릴까요?', confirmLabel: '버리기', tone: 'danger' }).then((ok) => { if (ok) action(); });
  };
  const select = (row: CatalogProduct) => { if (row.id !== selectedId) guarded(() => { setSelectedId(row.id); fill(fromProduct(row), emptyStock()); setMessage(''); }); };
  const startNew = () => guarded(() => { setSelectedId(null); fill(emptyForm(), emptyStock()); setMessage(''); });
  const applyRow = (saved: CatalogProduct, text: string) => {
    setRows((current) => (current.some((row) => row.id === saved.id) ? current.map((row) => (row.id === saved.id ? saved : row)) : [...current, saved]));
    setSelectedId(saved.id); fill(fromProduct(saved), emptyStock()); setMessage(text); notify.success(text);
  };
  /** 실패 공통 처리: 충돌은 새로고침 안내, 결과를 알 수 없는 실패는 같은 요청으로 재시도하도록 operation_id를 유지한다. */
  function failed(error: unknown, tracker: { reset(): void }) {
    const status = (error as { status?: number }).status;
    if (isDefiniteRejection(error)) tracker.reset();
    setMessage(status === 409 ? '다른 변경과 충돌했습니다. 새로고침 후 다시 확인하세요.'
      : isDefiniteRejection(error) ? '저장하지 못했습니다. 입력 내용은 유지됩니다.'
        : '결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하면 중복 없이 처리됩니다.');
  }

  async function save() {
    const input = toProductInput(form);
    if (typeof input === 'string') { setMessage(input); return; }
    setBusy(true);
    try {
      const operation_id = saveOp.idFor(JSON.stringify([selected?.id ?? null, selected?.version ?? null, input]));
      const saved = selected
        ? await catalogApi.updateProduct(api, organizationId, selected.id, { ...input, expected_version: selected.version, operation_id })
        : await catalogApi.createProduct(api, organizationId, { ...input, operation_id });
      saveOp.reset(); applyRow(saved, '판매 조건을 저장했습니다.');
    } catch (error) { failed(error, saveOp); }
    finally { setBusy(false); }
  }

  async function receive() {
    if (!selected || selected.kind !== 'product') return;
    const quantity = Number(stock.quantity), reason = stock.reason.trim();
    if (!reason || !Number.isInteger(quantity) || quantity < 1 || quantity > 999_999) { setMessage('실물 상품을 선택하고 입고 사유를 입력하세요.'); return; }
    setBusy(true);
    try {
      const saved = await catalogApi.receiveStock(api, organizationId, selected.id, { quantity, reason, operation_id: receiptOp.idFor(JSON.stringify([selected.id, quantity, reason, selected.stock_quantity])) });
      receiptOp.reset(); applyRow(saved, '입고를 기록했습니다.');
    } catch (error) { failed(error, receiptOp); }
    finally { setBusy(false); }
  }

  async function change() {
    if (!selected || selected.kind !== 'product') return;
    const quantity = Number(stock.quantity), reason = stock.reason.trim();
    const max = stock.kind === 'stocktake' ? 1_000_000_000 : 999_999;
    if (!reason || !Number.isInteger(quantity) || quantity < (stock.kind === 'stocktake' ? 0 : 1) || quantity > max) {
      setMessage('실물 상품과 사유를 확인하세요. 반품·폐기 수량은 1개 이상이어야 합니다.'); return;
    }
    setBusy(true);
    try {
      const saved = await catalogApi.changeStock(api, organizationId, selected.id, {
        kind: stock.kind, quantity, reason, expected_version: selected.version, operation_id: adjustOp.idFor(JSON.stringify([selected.id, selected.version, stock.kind, quantity, reason])),
      });
      adjustOp.reset(); applyRow(saved, '재고 변동을 기록했습니다.');
    } catch (error) { failed(error, adjustOp); }
    finally { setBusy(false); }
  }

  async function showHistory() {
    if (!selected || selected.kind !== 'product') return;
    setBusy(true);
    try {
      const movements = await catalogApi.listStockLedger(api, organizationId, selected.id);
      setHistory({ product: selected, movements }); setMessage(`최근 재고 변동 ${movements.length}건을 표시했습니다.`);
    } catch { setMessage('재고 변동 이력을 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  }

  const visible = useMemo(() => rows.filter((row) => (kindFilter === 'all' || row.kind === kindFilter) && `${row.name} ${row.sku}`.toLowerCase().includes(query.trim().toLowerCase())), [rows, kindFilter, query]);
  const columns: Column<CatalogProduct>[] = [
    { key: 'kind', header: '구분', width: 70, value: (row) => (row.kind === 'product' ? '상품' : '회원권') },
    { key: 'name', header: '이름', width: 180, value: (row) => row.name },
    { key: 'sku', header: 'SKU', width: 110, value: (row) => row.sku },
    { key: 'price', header: '판매가', width: 100, value: (row) => Number(row.sale_price), render: (row) => won(row.sale_price) },
    { key: 'stock', header: '재고', width: 70, value: (row) => (row.kind === 'product' ? row.stock_quantity : -1), render: (row) => (row.kind === 'product' ? String(row.stock_quantity) : '-') },
    { key: 'state', header: '상태', width: 80, value: (row) => (row.is_active ? '판매 중' : '판매 중지') },
  ];
  const membership = form.kind === 'membership';
  const isProduct = selected?.kind === 'product';
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <section className="catalog-page">
      <div className="page-toolbar">
        <div><h1>상품 · 회원권 · 재고</h1><p className="muted">판매 조건은 장바구니에 담는 순간 고정됩니다. 실물 상품은 입고 수량 안에서만 결제할 수 있습니다.</p></div>
        {!readOnly && <button type="button" className="primary-button" disabled={busy} onClick={startNew}>새 상품</button>}
      </div>
      {loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : loading ? <LoadingState label="상품과 회원권을 불러오는 중…" /> : (
        <div className="catalog-layout">
          <section className="catalog-list">
            <div className="list-controls">
              <input aria-label="상품 검색" placeholder="이름, SKU 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
              <Select<'all' | 'product' | 'membership'> aria-label="구분 필터" value={kindFilter} onChange={setKindFilter} options={[{ value: 'all', label: '전체' }, { value: 'product', label: '실물 상품' }, { value: 'membership', label: '회원권 · 패키지' }]} />
            </div>
            <DataGrid rows={visible} columns={columns} rowKey={(row) => row.id} selectedKey={selectedId} onSelect={select} ariaLabel="상품 목록" storageKey="catalog-grid" emptyText="등록된 상품과 회원권이 없습니다." />
          </section>
          <aside className="catalog-detail editor-panel">
            <h2>판매 조건</h2>
            <div className="catalog-form">
              <label>종류<Select<'product' | 'membership'> aria-label="종류" value={form.kind} disabled={!editable || selected !== null} onChange={(value) => set('kind', value)} options={[{ value: 'product', label: '실물 상품' }, { value: 'membership', label: '회원권 · 패키지' }]} /></label>
              <label>SKU<input value={form.sku} disabled={!editable} onChange={(event) => set('sku', event.currentTarget.value)} /></label>
              <label>이름<input value={form.name} disabled={!editable} onChange={(event) => set('name', event.currentTarget.value)} /></label>
              <label>판매 단위<input value={form.unit_name} disabled={!editable} onChange={(event) => set('unit_name', event.currentTarget.value)} /></label>
              <label>판매가<input inputMode="numeric" placeholder="원 단위 정수" value={form.sale_price} disabled={!editable} onChange={(event) => set('sale_price', event.currentTarget.value)} /></label>
              <label>제공 금액<input inputMode="numeric" value={form.benefit_money} disabled={!editable || !membership} onChange={(event) => set('benefit_money', event.currentTarget.value)} /></label>
              <label>제공 횟수<input type="number" min={0} max={999999} value={form.benefit_count} disabled={!editable || !membership} onChange={(event) => set('benefit_count', event.currentTarget.value)} /></label>
              <label>유효 일수<input type="number" min={0} max={3650} placeholder="기간 제한 없음" value={form.valid_days} disabled={!editable || !membership} onChange={(event) => set('valid_days', event.currentTarget.value)} /></label>
              <label className="check"><input type="checkbox" checked={form.is_active} disabled={!editable} onChange={(event) => set('is_active', event.currentTarget.checked)} />판매 중</label>
              {!readOnly && <div className="form-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>저장</button></div>}
            </div>
            {selected && isProduct && (
              <div className="catalog-form" aria-label="재고 변동">
                <h3 className="full">재고 · 현재 {selected.stock_quantity}{selected.unit_name}</h3>
                {!readOnly && (
                  <>
                    <label>변동 종류<Select<StockChangeKind> aria-label="변동 종류" value={stock.kind} disabled={busy} onChange={(value) => setStock({ ...stock, kind: value })} options={[{ value: 'supplier_return', label: '거래처 반품' }, { value: 'disposal', label: '폐기' }, { value: 'stocktake', label: '실사 수량으로 조정' }]} /></label>
                    <label>수량<input type="number" min={stock.kind === 'stocktake' ? 0 : 1} aria-label="수량" value={stock.quantity} disabled={busy} onChange={(event) => setStock({ ...stock, quantity: event.currentTarget.value })} /></label>
                    <label className="full">수량 변경 사유<input aria-label="수량 변경 사유" placeholder="수량 변경 사유" value={stock.reason} disabled={busy} onChange={(event) => setStock({ ...stock, reason: event.currentTarget.value })} /></label>
                    <div className="form-actions">
                      <button type="button" disabled={busy} onClick={() => void receive()}>선택 상품 입고</button>
                      <button type="button" disabled={busy} onClick={() => void change()}>재고 변동 기록</button>
                    </div>
                  </>
                )}
                <div className="form-actions"><button type="button" disabled={busy} onClick={() => void showHistory()}>재고 변동 이력</button></div>
              </div>
            )}
            {message && <p aria-live="polite" className="catalog-message">{message}</p>}
          </aside>
        </div>
      )}
      {history && (
        <Modal title={`${history.product.name} · 재고 변동 이력`} size="lg" onClose={() => setHistory(null)}>
          <DataGrid<StockMovement> rows={history.movements} rowKey={(row) => row.id} ariaLabel="재고 변동 이력" emptyText="재고 변동 이력이 없습니다."
            columns={[
              { key: 'at', header: '일시', width: 150, value: (row) => row.created_at, render: (row) => row.created_at.slice(0, 16).replace('T', ' ') },
              { key: 'kind', header: '변동 종류', width: 120, value: (row) => movementLabel[row.movement_kind] },
              { key: 'qty', header: '수량', width: 90, value: (row) => row.quantity, render: (row) => `${row.quantity > 0 ? '+' : ''}${row.quantity.toLocaleString('ko-KR')} ${history.product.unit_name}` },
              { key: 'reason', header: '사유', width: 240, value: (row) => row.reason },
            ]} />
        </Modal>
      )}
    </section>
  );
}
