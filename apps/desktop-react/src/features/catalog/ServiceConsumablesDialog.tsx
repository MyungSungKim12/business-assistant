import { useEffect, useState } from 'react';
import { confirm, ErrorState, LoadingState, Modal, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { catalogApi } from './api';
import type { CatalogProduct } from './schemas';
import { resourceApi } from '../appointment-resources/api';

export function ServiceConsumablesDialog({ api, organizationId, serviceId, readOnly, onClose }: {
  api: ApiClient; organizationId: string; serviceId: string; readOnly: boolean; onClose: () => void;
}) {
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [baseline, setBaseline] = useState('{}');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    setLoading(true); setError('');
    try {
      const [catalog, recipe] = await Promise.all([catalogApi.listProducts(api, organizationId), resourceApi.listConsumables(api, organizationId, serviceId)]);
      setProducts(catalog.filter((item) => item.kind === 'product'));
      const values = Object.fromEntries(recipe.map((item) => [item.product_id, String(item.quantity)]));
      setQuantities(values); setBaseline(JSON.stringify(values));
    } catch { setError('소모품 기준을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [api, organizationId, serviceId]);
  async function close() {
    if (busy) return;
    if (JSON.stringify(quantities) !== baseline && !await confirm({ title: '수정 중인 소모품 기준', message: '저장하지 않은 내용을 버릴까요?', confirmLabel: '버리기', tone: 'danger' })) return;
    onClose();
  }
  async function save() {
    const items = Object.entries(quantities).filter(([, value]) => value !== '').map(([product_id, value]) => ({ product_id, quantity: Number(value) }));
    if (items.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1_000_000)) { setError('소모량은 1~1,000,000 사이 정수로 입력하세요.'); return; }
    setBusy(true); setError('');
    try { await resourceApi.saveConsumables(api, organizationId, serviceId, items); notify.success('시술 소모품 기준을 저장했습니다.'); onClose(); }
    catch { setError('저장하지 못했습니다. 입력은 유지되며 다시 시도할 수 있습니다.'); }
    finally { setBusy(false); }
  }
  return <Modal title="시술 소모품 기준" onClose={() => void close()}>
    <div className="catalog-form">
      <p className="muted">시술 1회 완료 때 차감할 상품 수량입니다. 재고가 부족하면 시술 완료가 거부됩니다.</p>
      {loading ? <LoadingState /> : error && !products.length ? <ErrorState message={error} onRetry={() => void load()} /> : <>
        {!products.length && <p className="empty-state">등록된 실물 상품이 없습니다. 상품 메뉴에서 먼저 등록하세요.</p>}
        {products.map((product) => <label key={product.id} className="full">{product.name} · 현재 재고 {product.stock_quantity}{product.unit_name}
          <input aria-label={`${product.name} 시술 소모량`} type="number" min={1} max={1_000_000} step={1} placeholder="미사용" value={quantities[product.id] ?? ''} disabled={readOnly || busy} onChange={(event) => { const value = event.currentTarget.value; setQuantities((current) => ({ ...current, [product.id]: value })); }} />
        </label>)}
        {!readOnly && <div className="form-actions"><button type="button" className="primary-button" disabled={busy || loading} onClick={() => void save()}>기준 저장</button></div>}
      </>}
      {error && products.length > 0 && <p role="alert" className="form-error">{error}</p>}
    </div>
  </Modal>;
}
