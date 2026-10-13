import type { Customer } from '../../../api/schemas';
import type { MenuId } from '../../shell/TopBar';
import { LOW_STOCK_THRESHOLD, WALLET_WINDOW_DAYS, expiringWallets, groupDigits, lowStock, shortDate, type StockItem, type WalletRow } from '../dashboardMetrics';
import type { Source } from '../sourceState';
import { Panel } from './Panel';

export function LowStockPanel({ state, onRetry, onNavigate }: { state: Source<StockItem[]>; onRetry: () => void; onNavigate: (menu: MenuId) => void }) {
  const open = () => onNavigate('inventory');
  return (
    <Panel
      area="dash-area-stock"
      title="재고 부족"
      state={state}
      onRetry={onRetry}
      isEmpty={(products) => lowStock(products).length === 0}
      emptyText={`재고 ${LOW_STOCK_THRESHOLD}개 이하인 상품이 없습니다.`}
      headerExtra={(products) => products && <span className="dash-count">{lowStock(products).length}개</span>}
    >
      {(products) => (
        <ul className="dash-list">
          {lowStock(products).map((product) => (
            <li key={product.id}>
              <button type="button" className="dash-row dash-row--stock" onClick={open}>
                <span className="dash-row__main"><strong>{product.name}</strong></span>
                <span className={`dash-badge ${product.stock_quantity <= 0 ? 'dash-badge--canceled' : 'dash-badge--confirmed'}`}>
                  {groupDigits(product.stock_quantity)}{product.unit_name || '개'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function WalletExpiryPanel({ state, customers, today, onRetry, onNavigate }: {
  state: Source<WalletRow[]>; customers: Customer[] | null; today: string; onRetry: () => void; onNavigate: (menu: MenuId) => void;
}) {
  const open = () => onNavigate('memberships');
  const names = new Map((customers ?? []).map((customer) => [customer.id, customer.name]));
  return (
    <Panel
      area="dash-area-wallet"
      title={`회원권 만료 (${WALLET_WINDOW_DAYS}일)`}
      state={state}
      onRetry={onRetry}
      isEmpty={(wallets) => expiringWallets(wallets, today).length === 0}
      emptyText={`${WALLET_WINDOW_DAYS}일 안에 만료되는 회원권이 없습니다.`}
      headerExtra={(wallets) => wallets && <span className="dash-count">{expiringWallets(wallets, today).length}건</span>}
    >
      {(wallets) => (
        <ul className="dash-list">
          {expiringWallets(wallets, today).map((wallet) => (
            <li key={wallet.id}>
              <button type="button" className="dash-row dash-row--wallet" onClick={open}>
                <span className="dash-row__main">
                  <strong>{(wallet.customer_id && names.get(wallet.customer_id)) || '고객 정보 없음'}</strong>
                  <small>{wallet.name_snapshot || '회원권'}</small>
                </span>
                <small className="dash-row__date">{shortDate(wallet.expires_on)} (D-{wallet.daysLeft})</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
