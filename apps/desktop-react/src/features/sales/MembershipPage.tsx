import { useCallback, useEffect, useMemo, useState } from 'react';
import { DataGrid, ErrorState, LoadingState, Select, type Column } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { catalogApi } from '../catalog/api';
import { won, type OrganizationWallet } from '../catalog/schemas';
import { CustomerWalletDialog } from '../catalog/WalletDialogs';
import { MembershipDetail } from './MembershipDetail';
import { daysUntil, filterWallets, isExpiringSoon, kstToday, statusLabel, walletKind, walletStatus, type WalletStatusFilter } from './membershipLogic';
import './membership.css';

export interface MembershipPageProps { api: ApiClient; organizationId: string; readOnly?: boolean }

/** 고객 지갑(회원권·패키지) 중심 화면: 잔액·만료 현황, 정지·재개·연장, 잔액 변동 이력. 쓰기는 관리자(owner/admin)만. */
export function MembershipPage({ api, organizationId, readOnly = false }: MembershipPageProps) {
  const [wallets, setWallets] = useState<OrganizationWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<WalletStatusFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customerDialog, setCustomerDialog] = useState<string | null>(null);
  const today = useMemo(() => kstToday(), []);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setLoadError('');
    try { setWallets(await catalogApi.listOrganizationWallets(api, organizationId)); }
    catch (error) { setLoadError((error as { status?: number }).status === 403 ? '회원권을 볼 권한이 없습니다.' : '회원권 정보를 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [api, organizationId]);
  useEffect(() => { void load(true); }, [load]);

  const rows = useMemo(() => filterWallets(wallets, { query, status }, today), [wallets, query, status, today]);
  const expiringCount = useMemo(() => wallets.filter((wallet) => isExpiringSoon(wallet, today)).length, [wallets, today]);
  const selected = wallets.find((wallet) => wallet.id === selectedId) ?? null;

  const columns: Column<OrganizationWallet>[] = [
    { key: 'customer', header: '고객', width: 110, value: (row) => row.customer_name },
    { key: 'name', header: '회원권', width: 160, value: (row) => row.name_snapshot },
    { key: 'kind', header: '종류', width: 80, value: (row) => walletKind(row) },
    { key: 'money', header: '금액 잔액', width: 100, value: (row) => Number(row.money_balance), render: (row) => won(row.money_balance) },
    { key: 'count', header: '잔여 횟수', width: 80, value: (row) => row.count_balance, render: (row) => `${row.count_balance}회` },
    {
      key: 'expires', header: '만료일', width: 130, value: (row) => row.expires_on ?? '9999-12-31',
      render: (row) => {
        if (!row.expires_on) return '기간 제한 없음';
        const soon = isExpiringSoon(row, today);
        return <>{row.expires_on}{soon && <span className="membership-soon" title="30일 이내 만료">D-{daysUntil(row.expires_on, today)}</span>}</>;
      },
    },
    { key: 'status', header: '상태', width: 80, value: (row) => statusLabel[walletStatus(row, today)] },
  ];

  return (
    <section className="membership-page">
      <div className="page-toolbar">
        <div>
          <h1>회원권</h1>
          <p className="muted">고객별 회원권·패키지의 잔액과 만료를 확인하고 정지·재개·연장을 처리합니다.{expiringCount > 0 && ` 30일 이내 만료 ${expiringCount}건.`}</p>
        </div>
      </div>
      {loadError ? <ErrorState message={loadError} onRetry={() => void load(true)} /> : loading ? <LoadingState label="회원권을 불러오는 중…" /> : (
        <div className="membership-layout">
          <section className="membership-list">
            <div className="list-controls">
              <input aria-label="회원권 검색" placeholder="고객, 회원권 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
              <Select<WalletStatusFilter> aria-label="회원권 상태 필터" value={status} onChange={setStatus}
                options={[{ value: 'all', label: '상태 전체' }, { value: 'active', label: '사용 가능' }, { value: 'expiring', label: `만료 임박 30일 (${expiringCount})` }, { value: 'paused', label: '정지' }, { value: 'expired', label: '만료' }, { value: 'depleted', label: '소진' }]} />
            </div>
            <DataGrid rows={rows} columns={columns} rowKey={(row) => row.id} selectedKey={selectedId} onSelect={(row) => setSelectedId(row.id)} ariaLabel="회원권 목록" storageKey="membership-grid"
              emptyText={wallets.length === 0 ? '표시할 회원권이 없습니다.' : '조건에 맞는 회원권이 없습니다.'} />
          </section>
          {selected
            ? <MembershipDetail key={selected.id} api={api} organizationId={organizationId} wallet={selected} today={today} readOnly={readOnly} onChanged={() => void load()} onOpenCustomer={() => setCustomerDialog(selected.customer_id)} />
            : <aside className="membership-detail editor-panel"><h2>회원권 상세</h2><p className="muted">목록에서 회원권을 선택하면 잔액 변동 이력과 정지·재개·연장을 볼 수 있습니다.</p></aside>}
        </div>
      )}
      {customerDialog && <CustomerWalletDialog api={api} organizationId={organizationId} customerId={customerDialog} readOnly={readOnly} onClose={() => { setCustomerDialog(null); void load(); }} />}
    </section>
  );
}
