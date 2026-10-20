import { useMemo, useRef, useState } from 'react';
import { Modal, confirm, notify } from '@business-assistant/react-ui';
import type { CallApi } from '../appointment-resources/api';
import { createOperationTracker, isDefiniteRejection, type OperationTracker } from '../appointment-resources/operationIds';
import { catalogApi } from './api';
import { buildStocktakePlan, type StocktakeEntry } from './stock';
import type { CatalogProduct } from './schemas';
import './catalog.css';
import { useDraftProtection } from '../../app/DraftBoundary';

type RowState = { status: 'pending' | 'done' | 'failed'; message: string };
const DEFAULT_REASON = '정기 재고 실사';

export interface StocktakeDialogProps {
  api: CallApi;
  organizationId: string;
  /** 실사 대상(실물 상품). 일부 반영 후에는 onApplied로 최신 상품을 돌려주므로 부모 목록이 갱신된다. */
  products: CatalogProduct[];
  onApplied: (product: CatalogProduct) => void;
  onClose: () => void;
}

/** 실물 상품의 현재 재고와 실사 수량을 한 표에서 입력해 차이를 확인한 뒤 상품별 stocktake 요청으로 일괄 반영한다. */
export function StocktakeDialog({ api, organizationId, products, onApplied, onClose }: StocktakeDialogProps) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [applied, setApplied] = useState<Record<string, CatalogProduct>>({});
  const [busy, setBusy] = useState(false);
  const dirty = Object.values(counts).some(value => value.trim() !== '') || reason !== DEFAULT_REASON;
  useDraftProtection(dirty, busy);
  async function close() {
    if (busy) return;
    if (dirty && !(await confirm({ title: '작성 중인 실사', message: '아직 반영하지 않은 실사 입력을 버리고 닫을까요?', confirmLabel: '닫기', cancelLabel: '계속 작성' }))) return;
    onClose();
  }
  const [message, setMessage] = useState('');
  const trackers = useRef(new Map<string, OperationTracker>());

  const current = useMemo(() => products.map((product) => applied[product.id] ?? product), [products, applied]);
  const plan = useMemo(() => buildStocktakePlan(current, counts), [current, counts]);
  const invalidIds = new Set(plan.invalid.map((item) => item.product.id));

  const trackerFor = (productId: string) => {
    const existing = trackers.current.get(productId);
    if (existing) return existing;
    const created = createOperationTracker();
    trackers.current.set(productId, created);
    return created;
  };
  const setRow = (productId: string, state: RowState) => setRowStates((currentStates) => ({ ...currentStates, [productId]: state }));

  /** 한 상품을 반영한다. 같은 입력의 재시도는 같은 operation_id를 써서 서버에서 중복 없이 처리된다. */
  async function applyOne(entry: StocktakeEntry, text: string): Promise<boolean> {
    const tracker = trackerFor(entry.product.id);
    const operation_id = tracker.idFor(JSON.stringify([entry.product.id, entry.product.version, entry.counted, text]));
    try {
      const saved = await catalogApi.changeStock(api, organizationId, entry.product.id, {
        kind: 'stocktake', quantity: entry.counted, reason: text, expected_version: entry.product.version, operation_id,
      });
      tracker.reset();
      setApplied((currentApplied) => ({ ...currentApplied, [saved.id]: saved }));
      setCounts((currentCounts) => ({ ...currentCounts, [saved.id]: '' }));
      setRow(saved.id, { status: 'done', message: `${entry.counted}개로 반영` });
      onApplied(saved);
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (isDefiniteRejection(error)) tracker.reset();
      setRow(entry.product.id, {
        status: 'failed',
        message: status === 409 ? '다른 변경과 충돌했습니다. 목록을 새로고침한 뒤 다시 실사하세요.'
          : isDefiniteRejection(error) ? '서버가 거절했습니다.' : '결과를 확인하지 못했습니다. 다시 반영하면 중복 없이 처리됩니다.',
      });
      return false;
    }
  }

  async function submit() {
    const text = reason.trim();
    if (!text) { setMessage('실사 사유를 입력하세요.'); return; }
    if (plan.invalid.length > 0) { setMessage('실사 수량은 0 이상의 정수여야 합니다. 표시된 행을 확인하세요.'); return; }
    if (plan.entries.length === 0) { setMessage(plan.unchanged > 0 ? '재고와 차이가 있는 상품이 없습니다.' : '실사 수량을 입력하세요.'); return; }
    const increase = plan.entries.filter((entry) => entry.difference > 0).length;
    const ok = await confirm({
      title: '재고 실사 반영',
      message: `${plan.entries.length}개 상품의 재고를 실사 수량으로 조정합니다. (증가 ${increase}개 · 감소 ${plan.entries.length - increase}개) 반영한 내용은 재고 이력에 남고 되돌릴 수 없습니다.`,
      confirmLabel: '반영',
    });
    if (!ok) return;
    setBusy(true); setMessage('');
    let success = 0;
    for (const entry of plan.entries) if (await applyOne(entry, text)) success += 1;
    setBusy(false);
    const failed = plan.entries.length - success;
    setMessage(failed === 0 ? `${success}개 상품의 재고를 반영했습니다.` : `${success}개 반영, ${failed}개 실패했습니다. 실패한 행만 다시 반영할 수 있습니다.`);
    if (success > 0) notify.success(`재고 실사 ${success}건을 반영했습니다.`);
  }

  return (
    <Modal title="재고 실사" size="lg" onClose={() => void close()}>
      <div className="stocktake">
        <p className="muted">실제로 센 수량을 입력하세요. 입력하지 않은 상품은 바꾸지 않습니다.</p>
        <div className="stocktake-table" role="region" aria-label="실사 입력">
          <table>
            <thead><tr><th>상품</th><th>SKU</th><th className="num">현재 재고</th><th className="num">실사 수량</th><th className="num">차이</th><th>결과</th></tr></thead>
            <tbody>
              {current.map((product) => {
                const text = (counts[product.id] ?? '').trim();
                const entry = plan.entries.find((item) => item.product.id === product.id);
                const state = rowStates[product.id];
                return (
                  <tr key={product.id}>
                    <td>{product.name}</td>
                    <td>{product.sku}</td>
                    <td className="num">{product.stock_quantity.toLocaleString('ko-KR')}</td>
                    <td className="num">
                      <input type="number" min={0} aria-label={`${product.name} 실사 수량`} aria-invalid={invalidIds.has(product.id)} value={counts[product.id] ?? ''} disabled={busy}
                        onChange={(event) => setCounts({ ...counts, [product.id]: event.currentTarget.value })} />
                    </td>
                    <td className={`num ${entry && entry.difference < 0 ? 'diff-minus' : ''}`}>
                      {invalidIds.has(product.id) ? '오류' : entry ? `${entry.difference > 0 ? '+' : ''}${entry.difference.toLocaleString('ko-KR')}` : text === '' ? '' : '0'}
                    </td>
                    <td className={state?.status === 'failed' ? 'diff-minus' : undefined}>{state?.message ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {current.length === 0 && <p className="empty-state">실사할 실물 상품이 없습니다.</p>}
        </div>
        <div className="inline-form">
          <label>실사 사유<input value={reason} disabled={busy} onChange={(event) => setReason(event.currentTarget.value)} /></label>
          <span className="muted" aria-live="polite">차이 {plan.entries.length}건 · 일치 {plan.unchanged}건{plan.invalid.length ? ` · 오류 ${plan.invalid.length}건` : ''}</span>
          <button type="button" className="primary-button" disabled={busy || plan.entries.length === 0} onClick={() => void submit()}>차이 확인 후 반영</button>
          <button type="button" disabled={busy} onClick={() => void close()}>닫기</button>
        </div>
        {message && <p aria-live="polite" className="catalog-message">{message}</p>}
      </div>
    </Modal>
  );
}
