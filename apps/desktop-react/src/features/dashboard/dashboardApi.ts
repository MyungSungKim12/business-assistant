import { z } from 'zod';
import type { ApiClient } from '../../api/client';
import { appointmentsSchema, type Appointment, type AppointmentService, type AppointmentStaff } from '../../api/schemas';
import { productsSchema } from '../catalog/schemas';
import { salesApi } from '../sales/api';
import type { Settlement, Transaction } from '../sales/types';
import { addDaysKey, monthStartKey, type StockItem, type WalletRow } from './dashboardMetrics';

/** 대시보드가 쓰는 ApiClient의 부분. 테스트에서는 이 메서드만 가진 가짜를 넣는다. */
export type DashboardApi = Pick<ApiClient, 'call' | 'listCustomers' | 'listTasks' | 'listAppointmentStaff' | 'listAppointmentServices' | 'listOperationRecords'>;

const org = (organizationId: string) => `/organizations/${organizationId}`;

const walletRowSchema = z.object({
  id: z.string(),
  customer_id: z.string().optional(),
  name_snapshot: z.string().optional(),
  expires_on: z.string().nullable().optional(),
  lifecycle_status: z.string().optional(),
  money_balance: z.union([z.string(), z.number()]).optional(),
  count_balance: z.union([z.string(), z.number()]).optional(),
});

export interface TodayAppointments {
  appointments: Appointment[];
  staff: AppointmentStaff[];
  services: AppointmentService[];
}

export const dashboardApi = {
  /** 오늘 전후 하루를 받아 KST 날짜 경계는 화면에서 거른다. 직원·서비스 이름이 없어도 예약은 보여 준다. */
  async appointments(api: DashboardApi, organizationId: string, today: string): Promise<TodayAppointments> {
    const range = `from_date=${addDaysKey(today, -1)}&to_date=${addDaysKey(today, 1)}`;
    const [appointments, staff, services] = await Promise.all([
      api.call('GET', `${org(organizationId)}/appointments?${range}`, appointmentsSchema),
      api.listAppointmentStaff(organizationId).catch(() => [] as AppointmentStaff[]),
      api.listAppointmentServices(organizationId).catch(() => [] as AppointmentService[]),
    ]);
    return { appointments, staff, services };
  },

  /** 이번 달 초와 최근 14일 중 더 이른 날부터 오늘까지의 수입·지출을 한 번에 받는다. */
  transactions(api: DashboardApi, organizationId: string, today: string): Promise<Transaction[]> {
    const chartStart = addDaysKey(today, -13);
    const monthStart = monthStartKey(today);
    return salesApi.transactions(api as ApiClient, organizationId, { from: chartStart < monthStart ? chartStart : monthStart, to: today });
  },

  settlement(api: DashboardApi, organizationId: string, today: string): Promise<Settlement> {
    return salesApi.settlement(api as ApiClient, organizationId, today);
  },

  async products(api: DashboardApi, organizationId: string): Promise<StockItem[]> {
    const rows = await api.call('GET', `${org(organizationId)}/catalog-products`, productsSchema);
    return rows;
  },

  async wallets(api: DashboardApi, organizationId: string): Promise<WalletRow[]> {
    const rows = await api.listOperationRecords(organizationId, 'memberships');
    return rows.flatMap((row) => {
      const parsed = walletRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  },
};
