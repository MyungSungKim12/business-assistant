import { useDraftProtection } from '../../app/DraftBoundary';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { DataGrid, ErrorState, LoadingState, Modal, Select, confirm, notify, type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { isDefiniteRejection, useOperationTracker } from '../appointment-resources/operationIds';
import { ExportButton } from '../../lib/io/ExportButton';
import { movementExportColumns, productExportColumns } from '../../lib/io/domainColumns';
import { catalogApi, type ProductInput, type StockChangeKind } from './api';
import { fileApi } from '../documents/api';
import { movementLabel, won, type CatalogProduct, type StockMovement, type InventoryLot, type InventoryLotAlert } from './schemas';
import { StocktakeDialog } from './StocktakeDialog';
import { PurchaseOrdersDialog } from './PurchaseOrdersDialog';
import { emptyMovementFilter, filterMovements, isLowStock, lowStockLimit, parseLowStockInput, DEFAULT_LOW_STOCK, type MovementFilter } from './stock';
import './catalog.css';

type Form = { kind: 'product' | 'membership'; sku: string; name: string; unit_name: string; purchase_unit_name: string; units_per_purchase_unit: string; sale_price: string; benefit_money: string; benefit_count: string; valid_days: string; is_active: boolean };
type Stock = { kind: StockChangeKind; quantity: string; reason: string; expires_on: string; lot_code:string; unit_cost:string };
const emptyForm = (): Form => ({ kind: 'product', sku: '', name: '', unit_name: '개', purchase_unit_name: '개', units_per_purchase_unit: '1', sale_price: '', benefit_money: '0', benefit_count: '0', valid_days: '', is_active: true });
const emptyStock = (): Stock => ({ kind: 'supplier_return', quantity: '1', reason: '', expires_on:'', lot_code:'', unit_cost:'' });
const fromProduct = (row: CatalogProduct): Form => ({
  kind: row.kind, sku: row.sku, name: row.name, unit_name: row.unit_name, purchase_unit_name: row.purchase_unit_name, units_per_purchase_unit: String(row.units_per_purchase_unit), sale_price: row.sale_price, benefit_money: row.benefit_money,
  benefit_count: String(row.benefit_count), valid_days: row.valid_days === null ? '' : String(row.valid_days), is_active: row.is_active,
});
const lowText = (row: CatalogProduct | null): string => (row?.low_stock_threshold == null ? '' : String(row.low_stock_threshold));
const PRICE = /^[1-9][0-9]{0,11}$/;
const BENEFIT = /^(0|[1-9][0-9]{0,11})$/;
const LOT_ALERT_PAGE_SIZE = 200;
const LOT_ALERT_MAX_ROWS = 5000;

/** 입력을 서버 요청으로 바꾼다. 서버(Python과 동일 규칙)가 다시 검증하지만, 같은 문구로 먼저 안내한다. */
export function toProductInput(form: Form): ProductInput | string {
  const sku = form.sku.trim(), name = form.name.trim(), unit = form.unit_name.trim(), price = form.sale_price.trim(), benefit = form.benefit_money.trim();
  const purchaseUnit = form.purchase_unit_name.trim(), factor = Number(form.units_per_purchase_unit);
  if (!sku || !name || !unit || !PRICE.test(price)) return 'SKU, 이름, 단위와 1원 이상의 판매가를 확인하세요.';
  if (!purchaseUnit || purchaseUnit.length > 30 || !Number.isInteger(factor) || factor < 1 || factor > 1_000_000) return '매입 단위와 단위당 재고 수량을 확인하세요.';
  const count = Number(form.benefit_count || '0');
  if (form.kind === 'membership') {
    if (!BENEFIT.test(benefit) || !Number.isInteger(count) || count < 0 || count > 999_999 || (Number(benefit) === 0 && count === 0)) return '회원권은 제공 금액이나 제공 횟수가 필요합니다.';
    const days = form.valid_days.trim() === '' ? 0 : Number(form.valid_days);
    if (!Number.isInteger(days) || days < 0 || days > 3650) return '유효 일수는 1~3650일이며 비우면 기간 제한이 없습니다.';
    return { sku, name, kind: 'membership', unit_name: unit, purchase_unit_name: unit, units_per_purchase_unit: 1, sale_price: price, benefit_money: benefit, benefit_count: count, valid_days: days || null, is_active: form.is_active };
  }
  return { sku, name, kind: 'product', unit_name: unit, purchase_unit_name: purchaseUnit, units_per_purchase_unit: factor, sale_price: price, benefit_money: '0', benefit_count: 0, valid_days: null, is_active: form.is_active };
}

export interface InventoryPageProps { api: ApiClient; organizationId: string; readOnly: boolean }

/** 상품·회원권(판매 조건)과 재고(입고·반품·폐기·실사, 변동 이력) 관리. 쓰기는 관리자(owner/admin)만. */
export function InventoryPage({ api, organizationId, readOnly }: InventoryPageProps) {
  const [rows, setRows] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [lotAlerts, setLotAlerts] = useState<InventoryLotAlert[]>([]);
  const [lotAlertsError, setLotAlertsError] = useState('');
  const [lotAlertsLoading, setLotAlertsLoading] = useState(true);
  const [lotAlertsMoreLoading, setLotAlertsMoreLoading] = useState(false);
  const [lotAlertsHasMore, setLotAlertsHasMore] = useState(false);
  const lotAlertsOffset = useRef(0);
  const lotAlertsGeneration = useRef(0);
  const [query, setQuery] = useState('');
  const [barcodeScan, setBarcodeScan] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'product' | 'membership'>('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'low'>('all');
  const [categoryFilter,setCategoryFilter]=useState('all');
  const [lowStockText, setLowStockText] = useState('');
  const [stocktakeOpen, setStocktakeOpen] = useState(false);
  const [purchaseOpen,setPurchaseOpen]=useState(false);
  const [movementFilter, setMovementFilter] = useState<MovementFilter>(emptyMovementFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [stock, setStock] = useState<Stock>(emptyStock);
  const [metadata,setMetadata]=useState({category:'기타',barcode:''});
  const [metadataBaseline,setMetadataBaseline]=useState(JSON.stringify({category:'기타',barcode:''}));
  const [imagePreview,setImagePreview]=useState<string|null>(null);
  const [imagePreviewError,setImagePreviewError]=useState('');
  const [imageBusy,setImageBusy]=useState(false);
  const [baseline, setBaseline] = useState(() => JSON.stringify([emptyForm(), emptyStock(), '']));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<{ product: CatalogProduct; movements: StockMovement[] } | null>(null);
  const [lots, setLots] = useState<{ product: CatalogProduct; rows: InventoryLot[] } | null>(null);
  const saveOp = useOperationTracker();
  const metadataOp=useOperationTracker();
  const imageOp=useOperationTracker();
  const receiptOp = useOperationTracker();
  const adjustOp = useOperationTracker();

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  useEffect(()=>{
    let alive=true;let url:string|undefined;
    setImagePreview(null);setImagePreviewError('');
    if(!selected?.image_file_id)return;
    void fileApi.fetchPreview(api,organizationId,selected.image_file_id).then(({blob,kind})=>{
      if(!alive)return;if(kind!=='image')throw new Error('not image');url=URL.createObjectURL(blob);setImagePreview(url);
    }).catch(()=>{if(alive)setImagePreviewError('상품 이미지를 불러오지 못했습니다. 파일 접근 권한과 080 SQL 적용을 확인하세요.');});
    return()=>{alive=false;if(url)URL.revokeObjectURL(url);};
  },[api,organizationId,selected?.image_file_id]);
  const metadataDirty=JSON.stringify(metadata)!==metadataBaseline;
  const dirty = JSON.stringify([form, stock, lowStockText]) !== baseline || metadataDirty;
  useDraftProtection(dirty, busy);
  const editable = !readOnly && !busy;

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try { setRows(await catalogApi.listProducts(api, organizationId)); }
    catch (error) { setLoadError((error as { status?: number }).status === 403 ? '상품·재고 권한이 없습니다.' : '상품과 회원권을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [api, organizationId]);
  useEffect(() => { void load(); }, [load]);
  const loadLotAlerts = useCallback(async (reset = true) => {
    const generation = reset ? ++lotAlertsGeneration.current : lotAlertsGeneration.current;
    const offset = reset ? 0 : lotAlertsOffset.current;
    if (reset) { lotAlertsOffset.current = 0; setLotAlerts([]); setLotAlertsHasMore(false); setLotAlertsLoading(true); }
    else setLotAlertsMoreLoading(true);
    setLotAlertsError('');
    try {
      const page = await catalogApi.listInventoryLotAlerts(api, organizationId, 30, offset, LOT_ALERT_PAGE_SIZE);
      if (generation !== lotAlertsGeneration.current) return;
      lotAlertsOffset.current = offset + page.length;
      setLotAlerts((current) => reset ? page : [...current, ...page]);
      setLotAlertsHasMore(page.length === LOT_ALERT_PAGE_SIZE && lotAlertsOffset.current < LOT_ALERT_MAX_ROWS);
    }
    catch (error) {
      if (generation !== lotAlertsGeneration.current) return;
      if (reset) { lotAlertsOffset.current = 0; setLotAlerts([]); }
      setLotAlertsError((error as { status?: number }).status === 403 ? '유통기한 알림 조회 권한이 없습니다.' : '유통기한 알림을 불러오지 못했습니다. 091 SQL 적용 여부를 확인하세요.');
    } finally {
      if (generation === lotAlertsGeneration.current) { if (reset) setLotAlertsLoading(false); else setLotAlertsMoreLoading(false); }
    }
  }, [api, organizationId]);
  useEffect(() => { void loadLotAlerts(); }, [loadLotAlerts]);

  const fill = (next: Form, nextStock: Stock, low = '') => { setForm(next); setStock(nextStock); setLowStockText(low); setBaseline(JSON.stringify([next, nextStock, low])); };
  /** 변경이 없으면 바로, 있으면 확인을 거친 뒤 실행한다(변경 없는 이동은 동기로 처리된다). */
  const guarded = (action: () => void) => {
    if (!dirty) { action(); return; }
    void confirm({ title: '작성 중인 상품·재고 변경', message: '저장하지 않은 내용을 버릴까요?', confirmLabel: '버리기', tone: 'danger' }).then((ok) => { if (ok) action(); });
  };
  const setSavedMetadata=(row:Pick<CatalogProduct,'category'|'barcode'>)=>{const next={category:row.category??'기타',barcode:row.barcode??''};setMetadata(next);setMetadataBaseline(JSON.stringify(next));};
  const openProduct = (row: CatalogProduct) => { setSelectedId(row.id); fill(fromProduct(row), emptyStock(), lowText(row));setSavedMetadata(row); setMessage(''); };
  const select = (row: CatalogProduct) => { if (row.id !== selectedId) guarded(() => openProduct(row)); };
  const scanBarcode = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const code = barcodeScan.trim();
    if (!code) return;
    const matches = rows.filter((row) => row.barcode?.trim() === code);
    setBarcodeScan('');
    if (matches.length === 0) { setMessage('해당 바코드로 등록된 상품이 없습니다. 바코드 또는 상품 정보를 확인하세요.'); return; }
    if (matches.length > 1) { setMessage('같은 바코드가 여러 상품에 등록되어 있습니다. 상품 정보를 확인하세요.'); return; }
    const [match] = matches;
    setQuery(''); setKindFilter('all'); setStockFilter('all'); setCategoryFilter('all');
    guarded(() => { openProduct(match!); setMessage(`바코드로 ${match!.name} 상품을 찾았습니다.`); });
  };
  const startNew = () => guarded(() => { setSelectedId(null); fill(emptyForm(), emptyStock());setSavedMetadata({category:'기타',barcode:null}); setMessage(''); });
  const applyRow = (saved: CatalogProduct, text: string) => {
    const keepMetadataDraft=JSON.stringify(metadata)!==metadataBaseline;
    setRows((current) => (current.some((row) => row.id === saved.id) ? current.map((row) => (row.id === saved.id ? saved : row)) : [...current, saved]));
    setSelectedId(saved.id); fill(fromProduct(saved), emptyStock(), lowText(saved));if(!keepMetadataDraft)setSavedMetadata(saved); setMessage(text); notify.success(text);
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

  async function saveMetadata(){
    if(!selected||busy||readOnly)return;
    const category=metadata.category.trim(),barcode=metadata.barcode.trim()||null;
    if(!category||category.length>80|| (barcode!==null&&barcode.length>80)){setMessage('분류는 1~80자, 바코드는 80자 이내로 입력하세요.');return;}
    setBusy(true);
    try{const saved=await catalogApi.setProductMetadata(api,organizationId,selected.id,{category,barcode,expected_version:selected.version,operation_id:metadataOp.idFor(JSON.stringify([selected.id,selected.version,category,barcode]))});metadataOp.reset();setRows(current=>current.map(row=>row.id===saved.id?saved:row));setSavedMetadata(saved);setMessage('상품 분류와 바코드를 저장했습니다.');notify.success('상품 분류와 바코드를 저장했습니다.');}
    catch(error){failed(error,metadataOp);}
    finally{setBusy(false);}
  }

  async function uploadImage(){
    if(!selected||readOnly||imageBusy)return;
    const picker=api.filePlatform.pickFiles;
    if(!picker){setMessage('이 앱에서 파일 선택을 사용할 수 없습니다. 데스크톱 앱을 열어 주세요.');return;}
    setImageBusy(true);setMessage('');
    try{
      const picked=await picker();if(!picked.length)return;
      const source=picked[0]!;const type=source.contentType.toLowerCase();
      if(!['image/jpeg','image/png','image/webp'].includes(type)||source.size>5*1024*1024){setMessage('JPG, PNG, WebP 형식의 5MB 이하 이미지를 선택하세요.');return;}
      const file=await fileApi.upload(api,organizationId,source);
      const saved=await catalogApi.setProductImage(api,organizationId,selected.id,{image_file_id:file.id,expected_version:selected.version,operation_id:imageOp.idFor(JSON.stringify([selected.id,selected.version,file.id]))});
      imageOp.reset();setRows(current=>current.map(row=>row.id===saved.id?saved:row));setMessage('상품 이미지를 저장했습니다. 원본 파일은 파일 자료에도 보관됩니다.');notify.success('상품 이미지를 저장했습니다.');
    }catch(error){setMessage((error as {status?:number}).status===409?'상품 정보가 바뀌었습니다. 다시 불러온 뒤 이미지를 연결하세요.':'이미지를 저장하지 못했습니다. 업로드 파일은 파일 자료에 남아 있을 수 있습니다.');}
    finally{setImageBusy(false);}
  }
  async function removeImage(){
    if(!selected||readOnly||imageBusy||!selected.image_file_id)return;
    setImageBusy(true);try{const saved=await catalogApi.setProductImage(api,organizationId,selected.id,{image_file_id:null,expected_version:selected.version,operation_id:imageOp.idFor(JSON.stringify([selected.id,selected.version,null]))});imageOp.reset();setRows(current=>current.map(row=>row.id===saved.id?saved:row));setImagePreview(null);setMessage('상품 이미지 연결을 해제했습니다. 원본 파일은 파일 자료에 남아 있습니다.');}catch{setMessage('상품 이미지 연결을 해제하지 못했습니다. 새로고침 후 다시 시도하세요.');}finally{setImageBusy(false);}
  }

  async function receive() {
    if (!selected || selected.kind !== 'product') return;
    const quantity = Number(stock.quantity), reason = stock.reason.trim();
    if (!reason || !Number.isInteger(quantity) || quantity < 1 || quantity > 999_999) { setMessage('실물 상품을 선택하고 입고 사유를 입력하세요.'); return; }
    setBusy(true);
    try {
    if(stock.unit_cost!==''&&!/^(0|[1-9][0-9]{0,11})$/.test(stock.unit_cost)){setMessage('매입 단가는 0원 이상 12자리 이내로 입력하세요. 모르면 비워 두세요.');return;}
    const saved = await catalogApi.receiveStock(api, organizationId, selected.id, { quantity, reason, expires_on:stock.expires_on||null, lot_code:stock.lot_code.trim(), unit_cost:stock.unit_cost||null, operation_id: receiptOp.idFor(JSON.stringify([selected.id, quantity, reason, stock.expires_on, stock.lot_code, stock.unit_cost, selected.stock_quantity])) });
      receiptOp.reset(); applyRow(saved, '입고를 기록했습니다.');
      void loadLotAlerts();
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
      adjustOp.reset(); applyRow(saved, '재고 변동을 기록했습니다.'); void loadLotAlerts();
    } catch (error) { failed(error, adjustOp); }
    finally { setBusy(false); }
  }

  const lowOp = useOperationTracker();
  /** 안전재고만 저장한다. 판매 조건 저장과 별도 요청이라 입력 중인 다른 변경은 그대로 둔다. */
  async function saveLowStock() {
    if (!selected || selected.kind !== 'product') return;
    const parsed = parseLowStockInput(lowStockText);
    if (typeof parsed === 'string') { setMessage(parsed); return; }
    setBusy(true);
    try {
      const saved = await catalogApi.setLowStock(api, organizationId, selected.id, {
        low_stock_threshold: parsed, expected_version: selected.version, operation_id: lowOp.idFor(JSON.stringify([selected.id, selected.version, parsed])),
      });
      lowOp.reset();
      setRows((current) => current.map((row) => (row.id === saved.id ? saved : row)));
      setLowStockText(lowText(saved));
      setBaseline((current) => JSON.stringify([...(JSON.parse(current) as unknown[]).slice(0, 2), lowText(saved)]));
      setMessage('안전재고를 저장했습니다.'); notify.success('안전재고를 저장했습니다.');
    } catch (error) { failed(error, lowOp); }
    finally { setBusy(false); }
  }

  async function showHistory() {
    if (!selected || selected.kind !== 'product') return;
    setBusy(true);
    try {
      const movements = await catalogApi.listStockLedger(api, organizationId, selected.id);
      setMovementFilter(emptyMovementFilter()); setHistory({ product: selected, movements }); setMessage(`최근 재고 변동 ${movements.length}건을 표시했습니다.`);
    } catch { setMessage('재고 변동 이력을 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  }

  async function showLots() {
    if (!selected || selected.kind !== 'product') return;
    setBusy(true);
    try { setLots({ product: selected, rows: await catalogApi.listInventoryLots(api, organizationId, selected.id) }); }
    catch { setMessage('로트·유통기한 정보를 불러오지 못했습니다. 066 SQL 적용 여부를 확인하세요.'); }
    finally { setBusy(false); }
  }

  async function showAlertLot(productId: string) {
    const product = rows.find((row) => row.id === productId && row.kind === 'product');
    if (!product) { setMessage('상품 목록을 새로고침한 뒤 다시 시도하세요.'); return; }
    setBusy(true);
    try { setLots({ product, rows: await catalogApi.listInventoryLots(api, organizationId, product.id) }); }
    catch { setMessage('로트·유통기한 정보를 불러오지 못했습니다. 066 SQL 적용 여부를 확인하세요.'); }
    finally { setBusy(false); }
  }

  const visible = useMemo(() => rows.filter((row) => (kindFilter === 'all' || row.kind === kindFilter) && (stockFilter === 'all' || isLowStock(row)) && (categoryFilter==='all'||row.category===categoryFilter) && `${row.name} ${row.sku} ${row.category} ${row.barcode??''}`.toLowerCase().includes(query.trim().toLowerCase())), [rows, kindFilter, stockFilter, categoryFilter, query]);
  const lowCount = useMemo(() => rows.filter(isLowStock).length, [rows]);
  const movements = useMemo(() => (history ? filterMovements(history.movements, movementFilter) : []), [history, movementFilter]);
  const stocktakeProducts = useMemo(() => rows.filter((row) => row.kind === 'product'), [rows]);
  /** 실사로 반영된 상품을 목록에 바로 반영한다. */
  const applyStocktake = (saved: CatalogProduct) => { setRows((current) => current.map((row) => (row.id === saved.id ? saved : row))); void loadLotAlerts(); };
  const columns: Column<CatalogProduct>[] = [
    { key: 'kind', header: '구분', width: 70, value: (row) => (row.kind === 'product' ? '상품' : '회원권') },
    { key: 'name', header: '이름', width: 180, value: (row) => row.name },
    { key: 'category', header: '분류', width: 110, value:row=>row.category },
    { key: 'sku', header: 'SKU', width: 110, value: (row) => row.sku },
    { key: 'barcode', header: '바코드', width: 130, value:row=>row.barcode??'' },
    { key: 'price', header: '판매가', width: 100, value: (row) => Number(row.sale_price), render: (row) => won(row.sale_price) },
    { key: 'stock', header: '재고', width: 90, value: (row) => (row.kind === 'product' ? row.stock_quantity : -1),
      render: (row) => (row.kind === 'product' ? <>{row.stock_quantity}{isLowStock(row) && <span className="stock-badge" title={`안전재고 ${lowStockLimit(row)}개 이하`}>부족</span>}</> : '-') },
    { key: 'limit', header: '안전재고', width: 80, value: (row) => (row.kind === 'product' ? lowStockLimit(row) : -1), render: (row) => (row.kind === 'product' ? (row.low_stock_threshold == null ? `기본 ${DEFAULT_LOW_STOCK}` : String(row.low_stock_threshold)) : '-') },
    { key: 'state', header: '상태', width: 80, value: (row) => (row.is_active ? '판매 중' : '판매 중지') },
  ];
  const membership = form.kind === 'membership';
  const isProduct = selected?.kind === 'product';
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <section className="catalog-page">
      <div className="page-toolbar">
        <div><h1>상품 · 회원권 · 재고</h1><p className="muted">판매 조건은 장바구니에 담는 순간 고정됩니다. 실물 상품은 입고 수량 안에서만 결제할 수 있습니다.</p></div>
        <div className="catalog-toolbar-actions">
          <ExportButton title="상품 목록" columns={productExportColumns} rows={visible} disabled={loading || loadError !== ''} />
          {!readOnly && <button type="button" disabled={busy || loading || loadError !== ''} onClick={() => guarded(() => setStocktakeOpen(true))}>재고 실사</button>}
          {!readOnly&&<button type="button" disabled={busy||loading||loadError!==''} onClick={()=>setPurchaseOpen(true)}>공급처 · 발주</button>}
          {!readOnly && <button type="button" className="primary-button" disabled={busy} onClick={startNew}>새 상품</button>}
        </div>
      </div>
      <section className="inventory-expiry-alerts" aria-label="유통기한 알림">
        <div className="list-controls"><div><h2>유통기한 알림</h2><p className="muted">남은 수량이 있는 기한 경과 및 30일 이내 로트입니다. 현재 {lotAlerts.length.toLocaleString('ko-KR')}건 표시 중입니다.</p></div>
          <span>기한 경과 <strong>{lotAlerts.filter((row) => row.alert_status === 'expired').length}</strong></span>
          <span>30일 이내 <strong>{lotAlerts.filter((row) => row.alert_status === 'expiring_soon').length}</strong></span>
          <button type="button" disabled={lotAlertsLoading} onClick={() => void loadLotAlerts()}>새로고침</button>
        </div>
        {lotAlertsError && lotAlerts.length === 0 ? <ErrorState message={lotAlertsError} onRetry={() => void loadLotAlerts()} /> : lotAlertsLoading ? <LoadingState label="유통기한 알림을 불러오는 중…" /> : <>
          {lotAlertsError && <p role="alert" className="catalog-message">{lotAlertsError}</p>}
          <DataGrid<InventoryLotAlert> rows={lotAlerts} rowKey={(row) => row.id} ariaLabel="조직 전체 유통기한 알림" emptyText="기한 경과 또는 30일 이내 유통기한 로트가 없습니다."
            columns={[
              { key: 'product', header: '상품', width: 180, value: (row) => row.product_name },
              { key: 'lot', header: '로트', width: 130, value: (row) => row.lot_code || '미지정' },
              { key: 'remaining', header: '남은 수량', width: 100, value: (row) => row.remaining_quantity },
              { key: 'expiry', header: '유통기한', width: 120, value: (row) => row.expires_on ?? '' },
              { key: 'status', header: '상태', width: 100, value: (row) => row.alert_status === 'expired' ? '기한 경과' : '30일 이내' },
              { key: 'detail', header: '', width: 110, value: () => '', render: (row) => <button type="button" disabled={busy} onClick={() => void showAlertLot(row.product_id)}>로트 상세</button> },
            ]} />
          {lotAlertsHasMore && <button type="button" disabled={lotAlertsMoreLoading} onClick={() => void loadLotAlerts(false)}>{lotAlertsMoreLoading ? '불러오는 중…' : '다음 200건'}</button>}
          {lotAlertsOffset.current >= LOT_ALERT_MAX_ROWS && <p className="muted">최대 5,000건까지 표시했습니다. 나머지 기록은 상품별 로트 상세에서 확인하세요.</p>}
        </>}
      </section>
      {loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : loading ? <LoadingState label="상품과 회원권을 불러오는 중…" /> : (
        <div className="catalog-layout">
          <section className="catalog-list">
            <div className="list-controls">
              <input aria-label="상품 검색" placeholder="이름, SKU 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
              <input aria-label="바코드 스캔" placeholder="USB 스캐너로 읽고 Enter" title="키보드 입력 방식(USB HID) 바코드 스캐너를 지원합니다." autoComplete="off" spellCheck={false} value={barcodeScan} onChange={(event) => setBarcodeScan(event.currentTarget.value)} onKeyDown={scanBarcode} />
              <Select<'all' | 'product' | 'membership'> aria-label="구분 필터" value={kindFilter} onChange={setKindFilter} options={[{ value: 'all', label: '전체' }, { value: 'product', label: '실물 상품' }, { value: 'membership', label: '회원권 · 패키지' }]} />
              <Select<'all' | 'low'> aria-label="재고 필터" value={stockFilter} onChange={setStockFilter} options={[{ value: 'all', label: '재고 전체' }, { value: 'low', label: `재고 부족만 (${lowCount})` }]} />
              <Select aria-label="상품 분류 필터" value={categoryFilter} onChange={setCategoryFilter} options={[{value:'all',label:'분류 전체'},...Array.from(new Set(rows.map(row=>row.category))).sort((a,b)=>a.localeCompare(b,'ko')).map(category=>({value:category,label:category}))]} />
            </div>
            <DataGrid rows={visible} columns={columns} rowKey={(row) => row.id} selectedKey={selectedId} onSelect={select} ariaLabel="상품 목록" storageKey="catalog-grid" emptyText="등록된 상품과 회원권이 없습니다." />
          </section>
          <aside className="catalog-detail editor-panel">
            <h2>판매 조건</h2>
            <div className="catalog-form">
              <label>종류<Select<'product' | 'membership'> aria-label="종류" value={form.kind} disabled={!editable || selected !== null} onChange={(value) => set('kind', value)} options={[{ value: 'product', label: '실물 상품' }, { value: 'membership', label: '회원권 · 패키지' }]} /></label>
              <label>SKU<input value={form.sku} disabled={!editable} onChange={(event) => set('sku', event.currentTarget.value)} /></label>
              <label>이름<input value={form.name} disabled={!editable} onChange={(event) => set('name', event.currentTarget.value)} /></label>
              {selected&&<>
                <label>상품 분류<input aria-label="상품 분류" maxLength={80} value={metadata.category} disabled={!editable} onChange={event=>{const value=event.currentTarget.value;setMetadata(current=>({...current,category:value}));}}/></label>
                <label>바코드<input aria-label="바코드" maxLength={80} value={metadata.barcode} disabled={!editable} onChange={event=>{const value=event.currentTarget.value;setMetadata(current=>({...current,barcode:value}));}}/></label>
                {!readOnly&&<div className="form-actions"><button type="button" disabled={busy||!metadataDirty} onClick={()=>void saveMetadata()}>분류·바코드 저장</button></div>}
                <div className="catalog-form__image full" aria-label="상품 이미지">
                  <h3>상품 이미지</h3>
                  {imagePreview?<img src={imagePreview} alt={`${selected.name} 상품 이미지`} />:selected.image_file_id?<p className="muted" role="status">{imagePreviewError||'상품 이미지 불러오는 중…'}</p>:<p className="muted">등록된 이미지가 없습니다.</p>}
                  {!readOnly&&<div className="form-actions"><button type="button" disabled={imageBusy||busy} onClick={()=>void uploadImage()}>{selected.image_file_id?'이미지 교체':'이미지 등록'}</button>{selected.image_file_id&&<button type="button" disabled={imageBusy||busy} onClick={()=>void removeImage()}>이미지 연결 해제</button>}</div>}
                  <small className="muted">JPG · PNG · WebP, 5MB 이하. 비공개 파일 자료에 저장합니다.</small>
                </div>
              </>}
              <label>판매 단위<input value={form.unit_name} disabled={!editable} onChange={(event) => set('unit_name', event.currentTarget.value)} /></label>
              {!membership && <>
                <label>매입 단위<input aria-label="매입 단위" maxLength={30} value={form.purchase_unit_name} disabled={!editable} onChange={(event) => set('purchase_unit_name', event.currentTarget.value)} /></label>
                <label>매입 단위당 재고 수량<input aria-label="매입 단위당 재고 수량" type="number" min={1} max={1_000_000} value={form.units_per_purchase_unit} disabled={!editable} onChange={(event) => set('units_per_purchase_unit', event.currentTarget.value)} /></label>
                <small className="muted full">예: 박스당 12개라면 매입 단위는 박스, 재고 수량은 12입니다. 발주 생성 시 환산값이 해당 발주에 고정됩니다.</small>
              </>}
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
                    <label>입고 로트 번호<input aria-label="입고 로트 번호" maxLength={120} value={stock.lot_code} disabled={busy} onChange={event => setStock({ ...stock, lot_code:event.currentTarget.value })} /></label>
                    <label>입고 유통기한<input aria-label="입고 유통기한" type="date" value={stock.expires_on} disabled={busy} onChange={event => setStock({ ...stock, expires_on:event.currentTarget.value })} /></label>
                    <label>매입 단가 (원)<input aria-label="입고 매입 단가" inputMode="numeric" placeholder="모르면 비워 두세요" value={stock.unit_cost} disabled={busy} onChange={event => setStock({ ...stock, unit_cost:event.currentTarget.value })} /></label>
                    <div className="form-actions">
                      <button type="button" disabled={busy} onClick={() => void receive()}>선택 상품 입고</button>
                      <button type="button" disabled={busy} onClick={() => void change()}>재고 변동 기록</button>
                    </div>
                  </>
                )}
                <label className="full">안전재고 (이 수량 이하이면 재고 부족)
                  <input type="number" min={0} aria-label="안전재고" placeholder={`비우면 기본 ${DEFAULT_LOW_STOCK}개`} value={lowStockText} disabled={busy || readOnly} onChange={(event) => setLowStockText(event.currentTarget.value)} />
                </label>
                <div className="form-actions">
                  {!readOnly && <button type="button" disabled={busy} onClick={() => void saveLowStock()}>안전재고 저장</button>}
                  <button type="button" disabled={busy} onClick={() => void showHistory()}>재고 변동 이력</button>
                  <button type="button" disabled={busy} onClick={() => void showLots()}>로트·유통기한</button>
                </div>
              </div>
            )}
            {message && <p aria-live="polite" className="catalog-message">{message}</p>}
          </aside>
        </div>
      )}
      {history && (
        <Modal title={`${history.product.name} · 재고 변동 이력`} size="lg" onClose={() => setHistory(null)}>
          <div className="inline-form movement-filter">
            <label>시작일<input type="date" aria-label="이력 시작일" value={movementFilter.from} onChange={(event) => setMovementFilter({ ...movementFilter, from: event.currentTarget.value })} /></label>
            <label>종료일<input type="date" aria-label="이력 종료일" value={movementFilter.to} onChange={(event) => setMovementFilter({ ...movementFilter, to: event.currentTarget.value })} /></label>
            <label>변동 종류
              <Select<MovementFilter['kind']> aria-label="이력 종류" value={movementFilter.kind} onChange={(kind) => setMovementFilter({ ...movementFilter, kind })}
                options={[{ value: 'all', label: '전체' }, ...(Object.keys(movementLabel) as StockMovement['movement_kind'][]).map((kind) => ({ value: kind, label: movementLabel[kind] }))]} />
            </label>
            <button type="button" onClick={() => setMovementFilter(emptyMovementFilter())}>필터 해제</button>
            <span className="muted" aria-live="polite">최근 {history.movements.length}건 중 {movements.length}건</span>
            <ExportButton title={`${history.product.name} 재고 이력`} columns={movementExportColumns} rows={movements} />
          </div>
          <DataGrid<StockMovement> rows={movements} rowKey={(row) => row.id} ariaLabel="재고 변동 이력" emptyText={history.movements.length ? '조건에 맞는 이력이 없습니다.' : '재고 변동 이력이 없습니다.'}
            columns={[
              { key: 'at', header: '일시', width: 150, value: (row) => row.created_at, render: (row) => row.created_at.slice(0, 16).replace('T', ' ') },
              { key: 'kind', header: '변동 종류', width: 120, value: (row) => movementLabel[row.movement_kind] },
              { key: 'qty', header: '수량', width: 90, value: (row) => row.quantity, render: (row) => `${row.quantity > 0 ? '+' : ''}${row.quantity.toLocaleString('ko-KR')} ${history.product.unit_name}` },
              { key: 'reason', header: '사유', width: 240, value: (row) => row.reason },
            ]} />
        </Modal>
      )}
      {lots && <Modal title={`${lots.product.name} · 로트·유통기한`} size="lg" onClose={() => setLots(null)}>
        <p className="muted">유통기한 임박 기준은 30일입니다. 기한이 있는 로트부터 먼저 출고하며, 기한 없는 기존 재고는 뒤에 사용합니다.</p>
        <DataGrid<InventoryLot> rows={lots.rows} rowKey={row => row.id} ariaLabel="재고 로트" emptyText="남은 수량이 있는 로트가 없습니다."
          columns={[
            { key: 'lot', header: '로트 번호', width: 150, value: row => row.lot_code || '미지정' },
            { key: 'received', header: '입고 수량', width: 100, value: row => row.received_quantity },
            { key: 'remaining', header: '현재 수량', width: 100, value: row => row.remaining_quantity },
            { key: 'expiry', header: '유통기한', width: 120, value: row => row.expires_on ?? '', render: row => row.expires_on ?? '기한 미등록' },
            { key: 'cost', header: '매입 단가', width: 120, value: row => row.unit_cost??'', render: row => row.unit_cost===null?'미확인':won(row.unit_cost) },
            { key: 'alert', header: '상태', width: 110, value: row => row.alert_status, render: row => row.alert_status === 'expired' ? '기한 경과' : row.alert_status === 'expiring_soon' ? '임박' : '정상' },
          ]} />
      </Modal>}
      {stocktakeOpen && <StocktakeDialog api={api} organizationId={organizationId} products={stocktakeProducts} onApplied={applyStocktake} onClose={() => { setStocktakeOpen(false); void load(); void loadLotAlerts(); }} />}
      {purchaseOpen&&<PurchaseOrdersDialog api={api} organizationId={organizationId} products={rows} readOnly={readOnly} onClose={()=>{setPurchaseOpen(false);void load();void loadLotAlerts()}}/>}
    </section>
  );
}
