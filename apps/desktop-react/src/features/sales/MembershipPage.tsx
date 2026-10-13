import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { Customer } from '../../api/schemas';
import { salesApi } from './api';
import { formatWon } from './format';
import type { Wallet } from './types';
import './sales.css';

/** 고객별 회원권(지갑) 잔액 조회. 판매·사용·정지는 카탈로그 화면에서 처리한다. */
export function MembershipPage({ api, organizationId }: { api: ApiClient; organizationId: string; readOnly?: boolean }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, people] = await Promise.all([salesApi.wallets(api, organizationId), api.listCustomers(organizationId).catch(() => [] as Customer[])]);
      setWallets(list);
      setCustomers(people);
    } catch { setError('회원권 정보를 불러오지 못했습니다.'); } finally { setLoading(false); }
  }, [api, organizationId]);
  useEffect(() => { void load(); }, [load]);
  const names = useMemo(() => new Map(customers.map((customer) => [customer.id, customer.name])), [customers]);
  const rows = useMemo(() => wallets.filter((wallet) => `${names.get(wallet.customer_id ?? '') ?? ''} ${wallet.name_snapshot ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())), [wallets, names, query]);
  return <section className="membership-page">
    <div className="page-toolbar"><div><p className="eyebrow">MEMBERSHIP</p><h1>회원권</h1><p className="muted">고객별 이용권과 잔여 혜택을 확인합니다.</p></div>
      <input aria-label="회원권 검색" placeholder="고객, 회원권 검색" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
    {error && <div role="alert" className="form-error">{error} <button type="button" onClick={() => void load()}>다시 시도</button></div>}
    {loading ? <p role="status" className="muted">불러오는 중…</p> : <div className="data-surface"><table><caption>고객 회원권</caption>
      <thead><tr><th>고객</th><th>회원권</th><th>금액 잔액</th><th>횟수 잔액</th><th>유효기간</th><th>상태</th></tr></thead>
      <tbody>{rows.map((wallet) => <tr key={wallet.id}><td>{names.get(wallet.customer_id ?? '') ?? '—'}</td><td>{wallet.name_snapshot ?? '—'}</td>
        <td>{wallet.money_balance === undefined ? '—' : formatWon(wallet.money_balance)}</td><td>{wallet.count_balance ?? '—'}</td>
        <td>{wallet.expires_at ? wallet.expires_at.slice(0, 10) : '—'}</td><td>{wallet.status ?? ''}</td></tr>)}</tbody></table>
      {!error && rows.length === 0 && <p className="empty-state">표시할 회원권이 없습니다.</p>}</div>}
  </section>;
}
