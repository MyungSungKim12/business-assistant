import type { Customer, Task } from '../../api/schemas';
import type { Receivables, Transaction } from '../sales/types';
import { dashboardApi, type DashboardApi, type TodayAppointments } from './dashboardApi';
import type { StockItem, WalletRow } from './dashboardMetrics';
import { useSource, type Source } from './sourceState';

export interface DashboardSources {
  customers: Source<Customer[]>;
  tasks: Source<Task[]>;
  appointments: Source<TodayAppointments>;
  transactions: Source<Transaction[]>;
  receivables: Source<Receivables>;
  products: Source<StockItem[]>;
  wallets: Source<WalletRow[]>;
}

export interface DashboardReloaders {
  customers: () => void;
  tasks: () => void;
  appointments: () => void;
  transactions: () => void;
  receivables: () => void;
  products: () => void;
  wallets: () => void;
}

/**
 * 패널별 데이터 원본. 각 원본은 독립적으로 불러오고 실패해도 다른 원본에 영향을 주지 않는다.
 * refreshKey가 바뀌면 모두 다시 불러온다.
 */
export function useDashboardData(api: DashboardApi, organizationId: string, today: string, refreshKey: number): { sources: DashboardSources; reload: DashboardReloaders } {
  const [customers, reloadCustomers] = useSource(() => api.listCustomers(organizationId), [api, organizationId, refreshKey]);
  const [tasks, reloadTasks] = useSource(() => api.listTasks(organizationId), [api, organizationId, refreshKey]);
  const [appointments, reloadAppointments] = useSource(() => dashboardApi.appointments(api, organizationId, today), [api, organizationId, today, refreshKey]);
  const [transactions, reloadTransactions] = useSource(() => dashboardApi.transactions(api, organizationId, today), [api, organizationId, today, refreshKey]);
  const [receivables, reloadReceivables] = useSource(() => dashboardApi.receivables(api, organizationId), [api, organizationId, refreshKey]);
  const [products, reloadProducts] = useSource(() => dashboardApi.products(api, organizationId), [api, organizationId, refreshKey]);
  const [wallets, reloadWallets] = useSource(() => dashboardApi.wallets(api, organizationId), [api, organizationId, refreshKey]);
  return {
    sources: { customers, tasks, appointments, transactions, receivables, products, wallets },
    reload: {
      customers: reloadCustomers, tasks: reloadTasks, appointments: reloadAppointments, transactions: reloadTransactions,
      receivables: reloadReceivables, products: reloadProducts, wallets: reloadWallets,
    },
  };
}
