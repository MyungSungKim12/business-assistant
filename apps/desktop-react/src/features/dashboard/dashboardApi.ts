import { z } from 'zod';
import type { ApiClient } from '../../api/client';
import { appointmentsSchema, type Appointment, type AppointmentService, type AppointmentStaff } from '../../api/schemas';
import { salesApi } from '../sales/api';
import type { Receivables, Transaction } from '../sales/types';
import { CHART_MAX_DAYS, addDaysKey, monthStartKey, prevMonthStartKey, type StockItem, type WalletRow } from './dashboardMetrics';

/** 대시보드가 쓰는 ApiClient의 부분. 테스트에서는 이 메서드만 가진 가짜를 넣는다. */
export type DashboardApi = Pick<ApiClient, 'call' | 'listCustomers' | 'listTasks' | 'updateTask' | 'listAppointmentStaff' | 'listAppointmentServices' | 'listOperationRecords'>;

const org = (organizationId: string) => `/organizations/${organizationId}`;

/** 재고 부족 계산에 필요한 필드만 읽는다. low_stock_threshold는 서버가 아직 주지 않으면(구버전) 비어 있어도 된다. */
const stockItemSchema = z.object({
  id: z.string(), name: z.string(), kind: z.string(), is_active: z.boolean(), stock_quantity: z.number(), unit_name: z.string().optional(),
  low_stock_threshold: z.number().int().min(0).nullable().optional(),
});
const stockItemsSchema = z.array(stockItemSchema);

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

  /** 전월 1일, 이번 달 초, 최근 30일(차트 최대 기간) 중 가장 이른 날부터 오늘까지의 수입·지출을 한 번에 받는다. */
  transactions(api: DashboardApi, organizationId: string, today: string): Promise<Transaction[]> {
    const from = [addDaysKey(today, -(CHART_MAX_DAYS - 1)), prevMonthStartKey(today), monthStartKey(today)].sort()[0];
    return salesApi.transactions(api as ApiClient, organizationId, { from, to: today });
  },

  /** 조직 전체 미수금(오늘 미수가 아니다). 건수·합계와 오래된 미수 상위 몇 건을 받는다. */
  receivables(api: DashboardApi, organizationId: string): Promise<Receivables> {
    return salesApi.receivables(api as ApiClient, organizationId, 5);
  },

  async products(api: DashboardApi, organizationId: string): Promise<StockItem[]> {
    return api.call('GET', `${org(organizationId)}/catalog-products`, stockItemsSchema);
  },

  async wallets(api: DashboardApi, organizationId: string): Promise<WalletRow[]> {
    const rows = await api.listOperationRecords(organizationId, 'memberships');
    return rows.flatMap((row) => {
      const parsed = walletRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  },
};
