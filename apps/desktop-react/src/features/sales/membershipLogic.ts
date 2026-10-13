import type { OrganizationWallet, WalletHistoryEvent } from '../catalog/schemas';

/** 만료 임박으로 보는 기간(일). 대시보드의 만료 임박 지갑 기준과 같다. */
export const EXPIRY_WINDOW_DAYS = 30;
const KST_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;

export type WalletStatus = 'active' | 'paused' | 'expired' | 'depleted';
export type WalletStatusFilter = 'all' | WalletStatus | 'expiring';
export type WalletFilter = { query: string; status: WalletStatusFilter };

export const statusLabel: Record<WalletStatus, string> = { active: '사용 가능', paused: '정지', expired: '만료', depleted: '소진' };

/** 한국 날짜(YYYY-MM-DD). */
export const kstToday = (now: Date = new Date()): string => new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);

/** 오늘부터 만료일까지 남은 일수(오늘 만료=0, 지났으면 음수). 만료일이 없으면 null. */
export function daysUntil(expiresOn: string | null, today: string): number | null {
  if (expiresOn === null) return null;
  const end = Date.parse(`${expiresOn}T00:00:00Z`);
  const start = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(end) || Number.isNaN(start)) return null;
  return Math.round((end - start) / DAY_MS);
}

type StatusFields = Pick<OrganizationWallet, 'lifecycle_status' | 'money_balance' | 'count_balance' | 'expires_on'>;

/** 정지 > 소진 > 만료 > 사용 가능 순으로 상태를 정한다. */
export function walletStatus(wallet: StatusFields, today: string): WalletStatus {
  if (wallet.lifecycle_status === 'paused') return 'paused';
  if (Number(wallet.money_balance) === 0 && wallet.count_balance === 0) return 'depleted';
  const days = daysUntil(wallet.expires_on, today);
  if (days !== null && days < 0) return 'expired';
  return 'active';
}

/** 사용 가능한 지갑 중 만료일이 오늘~30일 이내인 것. */
export function isExpiringSoon(wallet: StatusFields, today: string): boolean {
  if (walletStatus(wallet, today) !== 'active') return false;
  const days = daysUntil(wallet.expires_on, today);
  return days !== null && days <= EXPIRY_WINDOW_DAYS;
}

/** 발급된 혜택으로 본 종류. */
export function walletKind(wallet: Pick<OrganizationWallet, 'issued_money' | 'issued_count'>): string {
  const money = Number(wallet.issued_money) > 0;
  const count = wallet.issued_count > 0;
  if (money && count) return '금액+횟수';
  if (money) return '금액권';
  return count ? '횟수권' : '-';
}

export function filterWallets(rows: OrganizationWallet[], filter: WalletFilter, today: string): OrganizationWallet[] {
  const needle = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (needle && !`${row.customer_name} ${row.name_snapshot}`.toLowerCase().includes(needle)) return false;
    if (filter.status === 'all') return true;
    if (filter.status === 'expiring') return isExpiringSoon(row, today);
    return walletStatus(row, today) === filter.status;
  });
}

const signedText = (value: number, unit: string) => `${value > 0 ? '+' : value < 0 ? '-' : ''}${Math.abs(value).toLocaleString('ko-KR')}${unit}`;
export const signedWon = (value: string | number): string => signedText(Number(value), '원');
export const signedCount = (value: number): string => signedText(value, '회');

/** 이력 한 줄의 부가 설명(사유, 연장 전후 만료일). */
export function historyDetail(event: WalletHistoryEvent): string {
  const parts: string[] = [];
  if (event.event_type === 'extend' && event.previous_expires_on && event.expires_on) parts.push(`만료일 ${event.previous_expires_on} → ${event.expires_on}`);
  if (event.event_type === 'resume' && event.previous_expires_on && event.expires_on && event.previous_expires_on !== event.expires_on) parts.push(`만료일 ${event.previous_expires_on} → ${event.expires_on}`);
  if (event.reason) parts.push(event.reason);
  return parts.join(' · ');
}
