import { useCallback, useEffect, useState } from 'react';
import { DataGrid, ErrorState, LoadingState, confirm, notify, type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { isDefiniteRejection, useOperationTracker } from '../appointment-resources/operationIds';
import { catalogApi, type WalletAction } from '../catalog/api';
import { walletEventLabel, won, type OrganizationWallet, type WalletHistoryEvent } from '../catalog/schemas';
import { daysUntil, historyDetail, isExpiringSoon, signedCount, signedWon, statusLabel, walletKind, walletStatus } from './membershipLogic';

const actionLabel: Record<WalletAction, string> = { pause: '정지', resume: '재개', extend: '기간 연장' };
const stamp = (value: string) => value.slice(0, 16).replace('T', ' ');

const historyColumns: Column<WalletHistoryEvent>[] = [
  { key: 'at', header: '일시', width: 130, value: (row) => row.occurred_at, render: (row) => stamp(row.occurred_at) },
  { key: 'type', header: '구분', width: 80, value: (row) => walletEventLabel[row.event_type] },
  { key: 'money', header: '금액 변동', width: 90, value: (row) => Number(row.money_delta), render: (row) => (Number(row.money_delta) === 0 ? '-' : signedWon(row.money_delta)) },
  { key: 'count', header: '횟수 변동', width: 80, value: (row) => row.count_delta, render: (row) => (row.count_delta === 0 ? '-' : signedCount(row.count_delta)) },
  { key: 'detail', header: '내용', width: 220, value: (row) => historyDetail(row) },
];

export interface MembershipDetailProps {
  api: ApiClient;
  organizationId: string;
  wallet: OrganizationWallet;
  today: string;
  /** 읽기 전용(member)이면 정지·재개·연장 버튼이 없다. */
  readOnly: boolean;
  /** 변경이 반영되면 부모가 목록을 다시 읽는다. */
  onChanged: () => void;
  onOpenCustomer: () => void;
}

/** 선택한 지갑의 요약, 정지·재개·연장(사유·버전·멱등 키), 잔액 변동 이력. */
export function MembershipDetail({ api, organizationId, wallet, today, readOnly, onChanged, onOpenCustomer }: MembershipDetailProps) {
  const [history, setHistory] = useState<WalletHistoryEvent[]>([]);
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [action, setAction] = useState<WalletAction | null>(null);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('7');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const op = useOperationTracker();

  const status = walletStatus(wallet, today);
  const remaining = daysUntil(wallet.expires_on, today);
  const expiring = isExpiringSoon(wallet, today);
  const canManage = !readOnly && !busy;

  const loadHistory = useCallback(async () => {
    setHistoryState('loading');
    try { setHistory(await catalogApi.listWalletHistory(api, organizationId, wallet.customer_id, wallet.id)); setHistoryState('ready'); }
    catch { setHistoryState('error'); }
  }, [api, organizationId, wallet.customer_id, wallet.id, wallet.lifecycle_version, wallet.money_balance, wallet.count_balance]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  async function submit() {
    if (!action) return;
    const trimmed = reason.trim();
    const extend = action === 'extend' ? Number(days) : null;
    if (!trimmed) { setMessage('변경 사유를 입력하세요.'); return; }
    if (extend !== null && (!Number.isInteger(extend) || extend < 1 || extend > 3650)) { setMessage('연장할 일수는 1~3650일이어야 합니다.'); return; }
    if (action === 'pause') {
      const ok = await confirm({ title: '회원권 정지', message: '정지하는 동안 이 회원권은 사용할 수 없습니다. 재개하면 정지한 기간만큼 만료일이 늘어납니다.', confirmLabel: '정지' });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await catalogApi.manageWallet(api, organizationId, wallet.customer_id, wallet.id, {
        action, extend_days: extend, reason: trimmed, expected_version: wallet.lifecycle_version,
        operation_id: op.idFor(JSON.stringify([wallet.id, wallet.lifecycle_version, action, extend, trimmed])),
      });
      op.reset(); setAction(null); setReason(''); setMessage(`회원권을 ${actionLabel[action]}했습니다.`); notify.success('회원권을 변경했습니다.');
      onChanged();
    } catch (error) {
      if (isDefiniteRejection(error)) op.reset();
      const code = (error as { status?: number }).status;
      setMessage(code === 409 ? '다른 변경과 충돌했습니다. 목록을 새로고침한 뒤 다시 확인하세요.'
        : isDefiniteRejection(error) ? '회원권 변경이 거절되었습니다. 상태를 다시 확인하세요.' : '결과가 불명확합니다. 같은 요청을 다시 시도하면 중복 없이 처리됩니다.');
    } finally { setBusy(false); }
  }

  return (
    <aside className="membership-detail editor-panel" aria-label="회원권 상세">
      <h2>{wallet.name_snapshot}</h2>
      <dl className="membership-summary">
        <div><dt>고객</dt><dd>{wallet.customer_name}</dd></div>
        <div><dt>종류</dt><dd>{walletKind(wallet)}</dd></div>
        <div><dt>금액 잔액</dt><dd>{won(wallet.money_balance)} <span className="muted">/ 발급 {won(wallet.issued_money)}</span></dd></div>
        <div><dt>잔여 횟수</dt><dd>{wallet.count_balance}회 <span className="muted">/ 발급 {wallet.issued_count}회</span></dd></div>
        <div><dt>유효 기간</dt><dd>{wallet.valid_from} ~ {wallet.expires_on ?? '기간 제한 없음'}{expiring && remaining !== null && <span className="membership-soon">D-{remaining}</span>}</dd></div>
        <div><dt>상태</dt><dd>{statusLabel[status]}{wallet.paused_on ? ` (${wallet.paused_on}부터)` : ''}</dd></div>
      </dl>
      <div className="membership-actions">
        {!readOnly && (
          <>
            <button type="button" disabled={!canManage || wallet.lifecycle_status !== 'active'} onClick={() => setAction('pause')}>정지</button>
            <button type="button" disabled={!canManage || wallet.lifecycle_status !== 'paused'} onClick={() => setAction('resume')}>재개</button>
            <button type="button" disabled={!canManage || !wallet.expires_on} onClick={() => setAction('extend')}>기간 연장</button>
          </>
        )}
        <button type="button" onClick={onOpenCustomer}>고객 회원권 전체</button>
      </div>
      {action && (
        <div className="inline-form" aria-label="회원권 변경">
          {action === 'extend' && <label>연장할 일수<input type="number" min={1} max={3650} value={days} onChange={(event) => setDays(event.currentTarget.value)} /></label>}
          <label>변경 사유<input value={reason} onChange={(event) => setReason(event.currentTarget.value)} /></label>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>{actionLabel[action]} 확인</button>
          <button type="button" disabled={busy} onClick={() => { setAction(null); setMessage(''); }}>취소</button>
        </div>
      )}
      {message && <p aria-live="polite" className="catalog-message">{message}</p>}
      <h3>잔액 변동 이력</h3>
      <div className="membership-history">
        {historyState === 'error' ? <ErrorState message="이력을 불러오지 못했습니다." onRetry={() => void loadHistory()} />
          : historyState === 'loading' ? <LoadingState label="이력을 불러오는 중…" />
            : <DataGrid<WalletHistoryEvent> rows={history} columns={historyColumns} rowKey={(row) => row.id} ariaLabel="잔액 변동 이력" emptyText="변동 이력이 없습니다." />}
      </div>
    </aside>
  );
}
