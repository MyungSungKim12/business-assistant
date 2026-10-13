import { useCallback, useEffect, useMemo, useState } from 'react';
import { DataGrid, ErrorState, LoadingState, Modal, Select, notify, type Column } from '@business-assistant/react-ui';
import { isDefiniteRejection, useOperationTracker } from '../appointment-resources/operationIds';
import type { CallApi } from '../appointment-resources/api';
import { catalogApi, type WalletAction } from './api';
import { won, type CartBundle, type CustomerWallet, type WalletUseResult } from './schemas';
import './catalog.css';

const statusLabel = (wallet: CustomerWallet) => (wallet.lifecycle_status === 'paused' ? '정지' : '사용 가능');

export interface CustomerWalletDialogProps {
  api: CallApi;
  organizationId: string;
  customerId: string;
  /** 읽기 전용(member)이면 잔여 혜택과 사용 내역만 보인다. 정지·재개·연장은 관리자만. */
  readOnly?: boolean;
  onClose: () => void;
}

/** 고객 회원권 · 잔여 혜택과 정지·재개·기간 연장(옛 CustomerWalletDialog). */
export function CustomerWalletDialog({ api, organizationId, customerId, readOnly = false, onClose }: CustomerWalletDialogProps) {
  const [wallets, setWallets] = useState<CustomerWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<WalletAction | null>(null);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('7');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const op = useOperationTracker();

  const load = useCallback(async () => {
    setLoadError('');
    try { setWallets(await catalogApi.listWallets(api, organizationId, customerId)); }
    catch { setLoadError('회원권을 불러오지 못했습니다. 잠시 후 다시 확인하세요.'); }
    finally { setLoading(false); }
  }, [api, organizationId, customerId]);
  useEffect(() => { void load(); }, [load]);

  const selected = wallets.find((item) => item.id === selectedId) ?? null;
  const canManage = !readOnly && !busy && selected !== null;
  const usages = useMemo(() => wallets.flatMap((wallet) => wallet.usage_history.map((usage) => ({ wallet, usage }))).sort((a, b) => b.usage.created_at.localeCompare(a.usage.created_at)), [wallets]);

  async function submit() {
    if (!selected || !action) return;
    const trimmed = reason.trim();
    const extend = action === 'extend' ? Number(days) : null;
    if (!trimmed) { setStatus('변경 사유를 입력하세요.'); return; }
    if (extend !== null && (!Number.isInteger(extend) || extend < 1 || extend > 3650)) { setStatus('연장할 일수는 1~3650일이어야 합니다.'); return; }
    setBusy(true);
    try {
      await catalogApi.manageWallet(api, organizationId, customerId, selected.id, {
        action, extend_days: extend, reason: trimmed, expected_version: selected.lifecycle_version,
        operation_id: op.idFor(JSON.stringify([selected.id, selected.lifecycle_version, action, extend, trimmed])),
      });
      op.reset(); setAction(null); setReason(''); setStatus('회원권을 변경했습니다.'); notify.success('회원권을 변경했습니다.');
      await load();
    } catch (error) {
      if (isDefiniteRejection(error)) op.reset();
      setStatus((error as { status?: number }).status === 409 ? '다른 변경과 충돌했습니다. 새로고침 후 다시 확인하세요.' : isDefiniteRejection(error) ? '회원권 변경이 거절되었습니다. 상태를 다시 확인하세요.' : '결과가 불명확합니다. 같은 요청을 다시 시도하면 중복 없이 처리됩니다.');
    } finally { setBusy(false); }
  }

  const columns: Column<CustomerWallet>[] = [
    { key: 'name', header: '회원권', width: 160, value: (row) => row.name_snapshot },
    { key: 'money', header: '잔여 금액', width: 100, value: (row) => Number(row.money_balance), render: (row) => won(row.money_balance) },
    { key: 'count', header: '잔여 횟수', width: 80, value: (row) => row.count_balance, render: (row) => `${row.count_balance}회` },
    { key: 'from', header: '시작일', width: 100, value: (row) => row.valid_from },
    { key: 'to', header: '만료일', width: 110, value: (row) => row.expires_on ?? '기간 제한 없음' },
    { key: 'state', header: '상태', width: 80, value: (row) => statusLabel(row) },
  ];

  return (
    <Modal title="고객 회원권 · 잔여 혜택" size="lg" onClose={onClose}>
      <div className="wallet-dialog">
        {loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : loading ? <LoadingState label="회원권을 불러오는 중…" /> : (
          <>
            <DataGrid rows={wallets} columns={columns} rowKey={(row) => row.id} selectedKey={selectedId} onSelect={(row) => { setSelectedId(row.id); setAction(null); }} ariaLabel="회원권 목록" emptyText="보유 회원권이 없습니다." />
            <DataGrid<(typeof usages)[number]> rows={usages} rowKey={(row) => row.usage.id} ariaLabel="회원권 사용 내역" emptyText="사용 내역이 없습니다."
              columns={[
                { key: 'at', header: '사용일', width: 140, value: (row) => row.usage.created_at, render: (row) => row.usage.created_at.slice(0, 16).replace('T', ' ') },
                { key: 'name', header: '회원권', width: 140, value: (row) => row.wallet.name_snapshot },
                { key: 'used', header: '사용', width: 80, value: (row) => row.usage.mode, render: (row) => (row.usage.mode === 'count' ? '1회' : won(Math.abs(Number(row.usage.money_delta)))) },
                { key: 'applied', header: '적용 금액', width: 100, value: (row) => Number(row.usage.applied_amount), render: (row) => won(row.usage.applied_amount) },
              ]} />
            {!readOnly && (
              <div className="wallet-actions">
                <button type="button" disabled={!canManage || selected.lifecycle_status !== 'active'} onClick={() => setAction('pause')}>정지</button>
                <button type="button" disabled={!canManage || selected.lifecycle_status !== 'paused'} onClick={() => setAction('resume')}>재개</button>
                <button type="button" disabled={!canManage || !selected.expires_on} onClick={() => setAction('extend')}>기간 연장</button>
              </div>
            )}
            {action && (
              <div className="inline-form" aria-label="회원권 변경">
                {action === 'extend' && <label>연장할 일수<input type="number" min={1} max={3650} value={days} onChange={(event) => setDays(event.currentTarget.value)} /></label>}
                <label>변경 사유<input value={reason} onChange={(event) => setReason(event.currentTarget.value)} /></label>
                <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>변경 확인</button>
                <button type="button" disabled={busy} onClick={() => setAction(null)}>취소</button>
              </div>
            )}
          </>
        )}
        {status && <p aria-live="polite" className="catalog-message">{status}</p>}
      </div>
    </Modal>
  );
}

type Line = { id: string; description: string; total: unknown };
function activeTreatmentLines(bundle: CartBundle): Line[] {
  return bundle.lines
    .filter((line) => line.status === 'active' && line.source_type === 'treatment_draft')
    .map((line) => ({ id: line.id, description: String(line.description_snapshot ?? '시술'), total: line.line_total }));
}

export interface WalletUseDialogProps {
  api: CallApi;
  organizationId: string;
  customerId: string;
  /** 방문 장바구니(매출 화면이 가진 SaleCartBundle). visit.id, cart.version, 활성 시술 줄(lines)을 사용한다. */
  bundle: CartBundle;
  readOnly?: boolean;
  /** 사용이 기록되면 서버 결과(새 cart_version, 남은 금액)를 알려 준다. */
  onUsed?: (result: WalletUseResult) => void;
  onClose: () => void;
}

/** 방문 시술 줄에 회원권(금액권·횟수권)을 적용(옛 WalletUseDialog). 관리자만 사용할 수 있다. */
export function WalletUseDialog({ api, organizationId, customerId, bundle, readOnly = false, onUsed, onClose }: WalletUseDialogProps) {
  const visitId = bundle.visit.id;
  const lines = useMemo(() => activeTreatmentLines(bundle), [bundle]);
  const [wallets, setWallets] = useState<CustomerWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [cartVersion, setCartVersion] = useState(bundle.cart.version);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lineId, setLineId] = useState(lines[0]?.id ?? '');
  const [mode, setMode] = useState<'money' | 'count'>('money');
  const [amount, setAmount] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const op = useOperationTracker();

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const rows = await catalogApi.listWallets(api, organizationId, customerId);
      setWallets(rows); setSelectedId((current) => current ?? rows[0]?.id ?? null);
      setStatus((current) => current || (rows.length ? '사용할 회원권과 시술을 선택하세요.' : '사용 가능한 회원권이 없습니다.'));
    } catch { setLoadError('회원권을 불러오지 못했습니다. 다시 열어 확인해 주세요.'); }
    finally { setLoading(false); }
  }, [api, organizationId, customerId]);
  useEffect(() => { void load(); }, [load]);

  const wallet = wallets.find((item) => item.id === selectedId) ?? null;
  const editable = !readOnly && !busy && wallets.length > 0 && lines.length > 0;

  async function use() {
    if (!wallet || !lineId) return;
    if (wallet.lifecycle_status === 'paused') { setStatus('정지된 회원권입니다. 관리자에게 문의하세요.'); return; }
    const trimmed = amount.trim();
    if (mode === 'money' && (!/^[1-9][0-9]{0,11}$/.test(trimmed) || Number(trimmed) > Number(wallet.money_balance))) { setStatus('잔여 금액 안에서 사용할 원 단위 금액을 입력하세요.'); return; }
    if (mode === 'count' && wallet.count_balance < 1) { setStatus('남은 횟수가 없습니다.'); return; }
    if (!confirmed) { setStatus('선택한 시술과 차감 혜택을 확인해 주세요.'); return; }
    const input = { wallet_id: wallet.id, sale_line_id: lineId, mode, amount: mode === 'money' ? trimmed : null, expected_cart_version: cartVersion, confirmed: true as const };
    setBusy(true);
    try {
      const result = await catalogApi.useWallet(api, organizationId, visitId, { ...input, operation_id: op.idFor(JSON.stringify(input)) });
      op.reset();
      if (typeof result.cart_version === 'number') setCartVersion(result.cart_version);
      setAmount(''); setConfirmed(false);
      setStatus(`회원권 사용을 기록했습니다. 남은 방문 금액은 ${won(result.outstanding_amount ?? 0)}입니다.`);
      notify.success('회원권 사용을 기록했습니다.');
      onUsed?.(result);
      await load();
    } catch (error) {
      if (isDefiniteRejection(error)) { op.reset(); setStatus('회원권 사용이 거절되었습니다. 방문·잔액을 새로 확인해 주세요.'); }
      else setStatus('사용 결과를 확인하지 못했습니다. 같은 요청을 다시 시도하면 중복 없이 처리됩니다.');
    } finally { setBusy(false); }
  }

  const columns: Column<CustomerWallet>[] = [
    { key: 'name', header: '회원권', width: 160, value: (row) => row.name_snapshot },
    { key: 'money', header: '잔여 금액', width: 100, value: (row) => Number(row.money_balance), render: (row) => won(row.money_balance) },
    { key: 'count', header: '잔여 횟수', width: 80, value: (row) => row.count_balance, render: (row) => `${row.count_balance}회` },
    { key: 'to', header: '만료일', width: 110, value: (row) => row.expires_on ?? '기간 제한 없음' },
  ];

  return (
    <Modal title="방문 시술에 회원권 사용" size="lg" onClose={onClose}>
      <div className="wallet-dialog">
        <p className="muted">금액권은 입력 금액을, 횟수권은 선택한 시술의 남은 금액 전체를 적용합니다. 회원권 사용은 별도 현금 매출을 만들지 않습니다.</p>
        {loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : loading ? <LoadingState label="회원권을 불러오는 중…" /> : (
          <>
            <DataGrid rows={wallets} columns={columns} rowKey={(row) => row.id} selectedKey={selectedId} onSelect={(row) => setSelectedId(row.id)} ariaLabel="사용할 회원권" emptyText="사용 가능한 회원권이 없습니다." />
            <div className="catalog-form">
              <label>적용 시술
                <Select aria-label="적용 시술" value={lineId} disabled={!editable} onChange={setLineId} options={lines.map((line) => ({ value: line.id, label: `${line.description} · ${won(line.total)}` }))} />
              </label>
              <label>사용 방식
                <Select<'money' | 'count'> aria-label="사용 방식" value={mode} disabled={!editable} onChange={setMode} options={[{ value: 'money', label: '금액권 사용' }, { value: 'count', label: '횟수권 1회 사용' }]} />
              </label>
              <label>사용 금액<input aria-label="사용 금액" inputMode="numeric" placeholder="사용할 금액 (원)" value={amount} disabled={!editable || mode !== 'money'} onChange={(event) => setAmount(event.currentTarget.value)} /></label>
              <label className="check full"><input type="checkbox" checked={confirmed} disabled={!editable} onChange={(event) => setConfirmed(event.currentTarget.checked)} />선택한 시술과 차감 혜택을 확인했습니다.</label>
              {!readOnly && <div className="form-actions"><button type="button" className="primary-button" disabled={!editable} onClick={() => void use()}>회원권 사용</button></div>}
            </div>
            {lines.length === 0 && <p className="muted">회원권을 적용할 활성 시술 줄이 없습니다.</p>}
          </>
        )}
        {status && <p aria-live="polite" className="catalog-message">{status}</p>}
      </div>
    </Modal>
  );
}
